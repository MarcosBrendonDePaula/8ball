//! Escrow de partidas 1v1 de 8-Ball, em SOL nativo.
//!
//! Este programa é a ÚNICA parte do sistema que precisa ser sem confiança.
//! Ele não sabe nada sobre sinuca: não conhece bolas, tacadas nem regras. Ele
//! guarda o dinheiro de duas pessoas e o entrega segundo regras que ninguém —
//! nem o operador do jogo — consegue burlar depois que o programa está no ar.
//!
//! A simulação da partida roda fora daqui, no servidor (ver docs/TDD.md §4).
//! O que amarra o resultado à realidade é o REPLAY, gravado on-chain: qualquer
//! um reproduz a partida e confere o vencedor.
//!
//! Fluxo:
//!   create_match  → A deposita, sala aberta
//!   join_match    → B deposita, partida comprometida
//!   cancel_match  → A desiste antes de B entrar, recebe de volta
//!   settle_match  → referee declara o vencedor, pote é distribuído
//!   claim_timeout → referee sumiu; qualquer um devolve o dinheiro aos dois

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hash;
use anchor_lang::system_program;

declare_id!("4Y3qRV52756DJgJDzvj9z5et5LX4Wr1Jm9cVEK4sS3ht");

pub const BPS_DENOMINATOR: u64 = 10_000;

/// Divisão inicial do pote: 90% vencedor, 5% casa, 5% protocolo.
///
/// São só o PONTO DE PARTIDA — os valores vivem no `Config` e a autoridade
/// ajusta com `set_splits`, sem recompilar. O rake certo é uma questão
/// empírica: 10% é alto para jogo de habilidade, e descobrir o número bom
/// exige medir retenção, não redeployar a cada palpite.
pub const DEFAULT_WINNER_BPS: u16 = 9_000;
pub const DEFAULT_HOUSE_BPS: u16 = 500;
pub const DEFAULT_PROTOCOL_BPS: u16 = 500;

/**
 * Teto de bytes do replay gravado on-chain.
 *
 * Casado com `MAX_REPLAY_BYTES` do pacote `@zinc-pool/replay`. Os tetos de lá
 * foram dimensionados por MEDIÇÃO de partidas simuladas, não por chute.
 *
 * O teto não vem daqui, vem da transação: ela não passa de 1232 bytes, e um
 * `settle_match` sem replay nenhum já gasta 510 com assinaturas, contas e
 * discriminador. Sobram 721, e 682 deixa margem para uma instrução de compute
 * budget.
 *
 * Este número JÁ ESTEVE ERRADO DUAS VEZES: dizia 856, de quando o cabeçalho
 * tinha 56 bytes, e a conta partia de "~900 bytes de dados por transação", que
 * é otimista demais. O efeito seria a liquidação falhar só nas partidas mais
 * longas, com dinheiro na mesa e nenhum teste curto acusando. Há um teste no
 * pacote `replay` que trava a igualdade entre os dois lados; se ele falhar,
 * corrija AQUI também.
 */
pub const MAX_REPLAY_BYTES: usize = 656;

/// Tamanho máximo do endereço de arquivamento da especificação.
/// Uma URL do Arweave tem ~62 caracteres; 128 dá folga para IPFS e afins.
pub const MAX_SPEC_URI_LEN: usize = 128;

/// Piso do que o vencedor recebe. É a proteção que NÃO depende de confiança:
/// nem a autoridade consegue transformar o jogo num rake de 50%. Mudar este
/// limite exige publicar um binário novo, o que é público e auditável.
pub const MIN_WINNER_BPS: u16 = 8_500;

/**
 * Prazo de uma partida COMPROMETIDA, decidido pelo contrato.
 *
 * O `timeout_seconds` do `create_match` governa só a sala esperando oponente —
 * é escolha do criador e só afeta o dinheiro dele. Depois que o segundo
 * jogador deposita, o relógio é REANCORADO aqui.
 *
 * A separação existe porque a versão anterior deixava o prazo da partida nas
 * mãos do criador, e isso era um free-roll: bastava assinar `create_match` com
 * 60 segundos em vez dos 3600 que o servidor sugere. A partida vencia antes da
 * segunda tacada, e quem estava perdendo acionava `claim_timeout` e recebia a
 * entrada de volta. Toda derrota virava empate, com o risco todo do outro lado.
 *
 * Foi reproduzido em devnet antes desta correção.
 */
pub const COMMITTED_TIMEOUT_SECONDS: i64 = 3_600;

/// Endereço incinerador da Solana. Lamports enviados para cá são destruídos
/// pelo runtime no fim do slot — some do supply, verificável no explorer.
///
/// É o análogo de `spl_token::burn` para SOL nativo. Quando o jogo passar a
/// aceitar um token SPL, `burn_treasury` troca esta transferência por um burn
/// de verdade; o resto da estrutura não muda.
pub const INCINERATOR: Pubkey = anchor_lang::solana_program::incinerator::ID;

#[program]
pub mod pool_escrow {
    use super::*;

    /// Configura o programa. Só roda uma vez.
    pub fn initialize(
        ctx: Context<Initialize>,
        referee: Pubkey,
        min_stake: u64,
        max_stake: u64,
    ) -> Result<()> {
        require!(min_stake > 0 && max_stake >= min_stake, EscrowError::InvalidStakeRange);

        let config = &mut ctx.accounts.config;
        config.authority = ctx.accounts.authority.key();
        config.referee = referee;
        config.min_stake = min_stake;
        config.max_stake = max_stake;
        config.paused = false;
        config.bump = ctx.bumps.config;
        config.winner_bps = DEFAULT_WINNER_BPS;
        config.house_bps = DEFAULT_HOUSE_BPS;
        config.protocol_bps = DEFAULT_PROTOCOL_BPS;
        Ok(())
    }

    /// Cria a mesa e deposita a entrada do criador.
    ///
    /// O depósito acontece AQUI, antes da mesa existir para qualquer efeito.
    /// Não há estado intermediário em que uma mesa esteja aberta sem lastro.
    pub fn create_match(
        ctx: Context<CreateMatch>,
        match_id: [u8; 16],
        stake: u64,
        timeout_seconds: i64,
        commit: [u8; 32],
    ) -> Result<()> {
        let config = &ctx.accounts.config;
        require!(!config.paused, EscrowError::Paused);
        require!(
            stake >= config.min_stake && stake <= config.max_stake,
            EscrowError::StakeOutOfRange
        );
        require!(
            (60..=86_400).contains(&timeout_seconds),
            EscrowError::InvalidTimeout
        );

        let now = Clock::get()?.unix_timestamp;
        let game = &mut ctx.accounts.game;
        game.match_id = match_id;
        game.creator = ctx.accounts.creator.key();
        game.opponent = Pubkey::default();
        game.stake = stake;
        game.state = MatchState::Waiting as u8;
        game.created_at = now;
        game.deadline = now
            .checked_add(timeout_seconds)
            .ok_or(EscrowError::MathOverflow)?;
        game.commit_creator = commit;
        game.bump = ctx.bumps.game;

        deposit(
            &ctx.accounts.creator,
            &ctx.accounts.game.to_account_info(),
            &ctx.accounts.system_program,
            stake,
        )
    }

    /// Segundo jogador entra e deposita o mesmo valor.
    pub fn join_match(ctx: Context<JoinMatch>, commit: [u8; 32]) -> Result<()> {
        require!(!ctx.accounts.config.paused, EscrowError::Paused);

        let now = Clock::get()?.unix_timestamp;
        let stake = {
            let game = &ctx.accounts.game;
            require!(game.state == MatchState::Waiting as u8, EscrowError::NotJoinable);
            require!(
                game.creator != ctx.accounts.opponent.key(),
                EscrowError::CannotJoinOwnMatch
            );
            require!(now < game.deadline, EscrowError::MatchExpired);
            game.stake
        };

        deposit(
            &ctx.accounts.opponent,
            &ctx.accounts.game.to_account_info(),
            &ctx.accounts.system_program,
            stake,
        )?;

        let game = &mut ctx.accounts.game;
        game.opponent = ctx.accounts.opponent.key();
        game.commit_opponent = commit;
        game.state = MatchState::Committed as u8;

        // O relógio da PARTIDA começa agora, com duração que o contrato define.
        // Antes disto o prazo continuava sendo o que o criador escolheu para a
        // sala, e ele podia escolher 60 segundos.
        game.deadline = now
            .checked_add(COMMITTED_TIMEOUT_SECONDS)
            .ok_or(EscrowError::MathOverflow)?;

        emit!(MatchCommitted {
            match_id: game.match_id,
            deadline: game.deadline,
        });

        Ok(())
    }

    /// Cancela uma mesa que nunca recebeu oponente. O depósito volta ao criador.
    ///
    /// Depois que a partida está comprometida, este caminho fecha: sair de uma
    /// partida em andamento é derrota, não reembolso.
    ///
    /// Antes do prazo, só o criador pode cancelar. **Depois do prazo, qualquer
    /// um pode** — e o dinheiro volta para o criador de qualquer forma, porque
    /// o destino é fixado por `close = creator`. Sem isso, um criador que
    /// sumisse deixaria o próprio SOL preso na PDA para sempre.
    pub fn cancel_match(ctx: Context<CancelMatch>) -> Result<()> {
        let game = &ctx.accounts.game;
        require!(game.state == MatchState::Waiting as u8, EscrowError::NotCancellable);

        if ctx.accounts.signer.key() != game.creator {
            let now = Clock::get()?.unix_timestamp;
            require!(now >= game.deadline, EscrowError::NotCreator);
        }
        // A conta é fechada por `close = creator`, o que devolve stake + rent.
        Ok(())
    }

    /// Liquida a partida, distribuindo o pote conforme a divisão do Config.
    ///
    /// Assinado pelo referee, cuja chave está no Config. O `result_hash` é o
    /// hash do replay e fica gravado no evento — é o que permite auditoria
    /// externa de que o vencedor declarado é o correto.
    pub fn settle_match(
        ctx: Context<SettleMatch>,
        winner: Pubkey,
        replay: Vec<u8>,
        nonce_creator: [u8; 32],
        nonce_opponent: [u8; 32],
    ) -> Result<()> {
        require!(replay.len() <= MAX_REPLAY_BYTES, EscrowError::ReplayTooLarge);
        let game = &ctx.accounts.game;
        require!(game.state == MatchState::Committed as u8, EscrowError::NotSettleable);
        require!(
            winner == game.creator || winner == game.opponent,
            EscrowError::WinnerNotInMatch
        );
        require!(
            ctx.accounts.winner.key() == winner,
            EscrowError::WinnerAccountMismatch
        );

        // Os nonces têm de bater com os compromissos feitos ao depositar. É o
        // que amarra o seed do replay a uma escolha que os DOIS jogadores
        // fizeram antes de saber o resultado — sem isto o referee escolhia o
        // seed e fabricava a partida inteira.
        require!(
            hash(&nonce_creator).to_bytes() == game.commit_creator,
            EscrowError::BadReveal
        );
        require!(
            hash(&nonce_opponent).to_bytes() == game.commit_opponent,
            EscrowError::BadReveal
        );

        let pot_bruto = game
            .stake
            .checked_mul(2)
            .ok_or(EscrowError::MathOverflow)?;

        /*
         * A PERMANÊNCIA É PAGA PELO POTE, não pela casa.
         *
         * O registro do replay fica na blockchain para sempre, e isso exige um
         * depósito de isenção de aluguel proporcional ao tamanho. NÃO é uma
         * cobrança recorrente — os lamports ficam parados na conta e voltariam
         * se ela fosse fechada. Mas nunca fechamos o registro, porque ele é a
         * prova da partida: na prática o capital fica imobilizado para sempre.
         *
         * Quem imobilizava era o referee — ou seja, nós. A conta estava
         * invertida: numa mesa de 0.01 SOL o depósito é 0.00685 e o rake da
         * casa é 0.001. Cada partida pequena travava quase sete vezes a
         * receita dela, sem limite de acumulação.
         *
         * Descontar do pote põe o custo onde ele nasce e faz a conta escalar
         * sozinha: quem aposta mais banca um replay maior sem esforço.
         */
        let aluguel = Rent::get()?.minimum_balance(MatchRecordV2::space(replay.len()));
        let pot = pot_bruto
            .checked_sub(aluguel)
            .ok_or(EscrowError::PotTooSmallForRecord)?;

        let (winner_bps, house_bps, _) = ctx.accounts.config.splits();
        let (prize, treasury_cut, house_cut) = split_pot(pot, winner_bps, house_bps)?;

        // A conta da partida é do programa, então movemos lamports direto.
        // O que sobrar (o rent) volta ao criador quando a conta é fechada.
        let game_info = ctx.accounts.game.to_account_info();
        let treasury_info = ctx.accounts.treasury_vault.to_account_info();
        let house_info = ctx.accounts.house_vault.to_account_info();

        // Devolve ao referee o aluguel que ele adiantou ao criar o registro.
        move_lamports(&game_info, &ctx.accounts.referee.to_account_info(), aluguel)?;

        move_lamports(&game_info, &ctx.accounts.winner, prize)?;
        move_lamports(&game_info, &treasury_info, treasury_cut)?;
        move_lamports(&game_info, &house_info, house_cut)?;

        let match_id = game.match_id;

        // Contabilidade acumulada: sem isto só dá para somar as taxas lendo o
        // histórico inteiro de transações, o que fica caro e frágil.
        let treasury = &mut ctx.accounts.treasury_vault;
        treasury.total_in = treasury
            .total_in
            .checked_add(treasury_cut)
            .ok_or(EscrowError::MathOverflow)?;

        let house = &mut ctx.accounts.house_vault;
        house.total_in = house.total_in.checked_add(house_cut).ok_or(EscrowError::MathOverflow)?;
        house.matches_settled = house.matches_settled.saturating_add(1);

        // Grava o registro PERMANENTE da partida.
        //
        // Evento em log seria mais barato, mas logs são podados pelos nós com
        // o tempo. Uma conta persiste enquanto pagar aluguel — e é isso que
        // sustenta a promessa de auditoria: daqui a anos, com o site fora do
        // ar, os bytes continuam lá para qualquer um verificar.
        let record = &mut ctx.accounts.record;
        record.match_id = match_id;
        record.winner = winner;
        record.loser = if winner == game.creator { game.opponent } else { game.creator };
        record.creator_won = winner == game.creator;
        record.nonce_creator = nonce_creator;
        record.nonce_opponent = nonce_opponent;
        record.pot = pot;
        record.settled_at = Clock::get()?.unix_timestamp;
        record.replay = replay;
        record.bump = ctx.bumps.record;

        emit!(MatchSettled {
            match_id,
            winner,
            pot,
            prize,
            treasury: treasury_cut,
            house: house_cut,
            // Calculado aqui: o replay está na conta, então guardar o hash
            // seria redundante — mas quem escuta o evento não tem a conta.
            result_hash: hash(&ctx.accounts.record.replay).to_bytes(),
        });

        Ok(())
    }

    /// Prazo estourado sem liquidação. Devolve o depósito aos dois.
    ///
    /// Qualquer um pode chamar — é de propósito. Se o referee sumir ou o
    /// servidor morrer, o dinheiro não fica preso: depois do prazo, um terceiro
    /// qualquer pode destravar os fundos, e eles só voltam para os jogadores.
    pub fn claim_timeout(ctx: Context<ClaimTimeout>) -> Result<()> {
        let game = &ctx.accounts.game;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= game.deadline, EscrowError::NotExpiredYet);
        require!(
            game.state == MatchState::Committed as u8,
            EscrowError::NotRefundable
        );

        let stake = game.stake;
        let game_info = ctx.accounts.game.to_account_info();
        // O criador recebe o resto (stake + rent) no fechamento da conta.
        move_lamports(&game_info, &ctx.accounts.opponent, stake)?;

        emit!(MatchRefunded {
            match_id: game.match_id,
            stake,
        });

        Ok(())
    }

    /// Pausa de emergência. Impede novas mesas; não afeta as em andamento.
    pub fn set_paused(ctx: Context<AdminOnly>, paused: bool) -> Result<()> {
        ctx.accounts.config.paused = paused;
        Ok(())
    }

    /// Troca as chaves de operação.
    ///
    /// Necessário por dois motivos práticos. Primeiro, rotação: se a chave do
    /// referee vazar, sem isto o programa inteiro vira sucata (ver §6.5 do
    /// TDD). Segundo, recuperação: uma configuração inicial errada deixaria
    /// `settle_match` permanentemente inacessível.
    ///
    /// Argumento `None` mantém o valor atual.
    pub fn set_config(
        ctx: Context<AdminOnly>,
        referee: Option<Pubkey>,
        min_stake: Option<u64>,
        max_stake: Option<u64>,
    ) -> Result<()> {
        let config = &mut ctx.accounts.config;

        if let Some(key) = referee {
            config.referee = key;
        }
        if let Some(value) = min_stake {
            config.min_stake = value;
        }
        if let Some(value) = max_stake {
            config.max_stake = value;
        }

        require!(
            config.min_stake > 0 && config.max_stake >= config.min_stake,
            EscrowError::InvalidStakeRange
        );

        // Trocar o referee é a mudança mais perigosa que a autoridade faz:
        // quem assina as liquidações passa a ser outro. Era a única sem
        // rastro, enquanto os saques e a divisão já emitiam evento.
        emit!(ConfigChanged {
            referee: config.referee,
            min_stake: config.min_stake,
            max_stake: config.max_stake,
        });
        Ok(())
    }

    /// Passa a autoridade para outra chave. Caminho só de ida — confira duas
    /// vezes antes, porque não há como desfazer sem a chave nova.
    pub fn set_authority(ctx: Context<AdminOnly>, authority: Pubkey) -> Result<()> {
        let previous = ctx.accounts.config.authority;
        ctx.accounts.config.authority = authority;

        emit!(AuthorityChanged {
            previous,
            current: authority,
        });
        Ok(())
    }

    /// Migra o Config para o layout atual.
    ///
    /// Cobre os dois formatos antigos: o original (sem divisão configurável) e
    /// o intermediário (com divisão, mas ainda carregando `house`/`treasury`
    /// como chaves soltas). Aqueles dois campos morreram quando os cofres
    /// viraram PDAs — ficavam ali confundindo quem lesse a configuração.
    ///
    /// Idempotente: rodar de novo num Config já migrado não faz nada.
    pub fn migrate_config(ctx: Context<MigrateConfig>) -> Result<()> {
        let info = ctx.accounts.config.to_account_info();
        let tamanho = info.data_len();

        if tamanho == Config::LEN {
            return Ok(()); // já migrado
        }
        require!(
            tamanho == Config::LEN_V1 || tamanho == Config::LEN_V2,
            EscrowError::NotConfigAccount
        );

        // Acesso cru de propósito: `Account<Config>` desserializaria com o
        // layout NOVO e falharia numa conta que ainda está no antigo.
        let (authority, referee, min_stake, max_stake, paused, bump, splits) = {
            let data = info.try_borrow_data()?;
            require!(data[..8] == Config::DISCRIMINATOR[..], EscrowError::NotConfigAccount);

            let ler_chave = |inicio: usize| -> Result<Pubkey> {
                Pubkey::try_from(&data[inicio..inicio + 32])
                    .map_err(|_| error!(EscrowError::NotConfigAccount))
            };
            let ler_u64 = |i: usize| u64::from_le_bytes(data[i..i + 8].try_into().unwrap());
            let ler_u16 = |i: usize| u16::from_le_bytes(data[i..i + 2].try_into().unwrap());

            // Offsets do layout antigo: house e treasury ocupavam 72..136.
            let splits = if tamanho == Config::LEN_V2 {
                (ler_u16(154), ler_u16(156), ler_u16(158))
            } else {
                (DEFAULT_WINNER_BPS, DEFAULT_HOUSE_BPS, DEFAULT_PROTOCOL_BPS)
            };

            (
                ler_chave(8)?,
                ler_chave(40)?,
                ler_u64(136),
                ler_u64(144),
                data[152],
                data[153],
                splits,
            )
        };

        require_keys_eq!(authority, ctx.accounts.authority.key(), EscrowError::NotAuthority);

        // Reescreve no layout novo. Tudo já foi lido para variáveis locais, então
        // sobrescrever posições que se sobrepõem é seguro.
        {
            let mut data = info.try_borrow_mut_data()?;
            data[8..40].copy_from_slice(authority.as_ref());
            data[40..72].copy_from_slice(referee.as_ref());
            data[72..80].copy_from_slice(&min_stake.to_le_bytes());
            data[80..88].copy_from_slice(&max_stake.to_le_bytes());
            data[88] = paused;
            data[89] = bump;
            let (w, h, p) = splits;
            data[90..92].copy_from_slice(&if w == 0 { DEFAULT_WINNER_BPS } else { w }.to_le_bytes());
            data[92..94].copy_from_slice(&if w == 0 { DEFAULT_HOUSE_BPS } else { h }.to_le_bytes());
            data[94..96].copy_from_slice(&if w == 0 { DEFAULT_PROTOCOL_BPS } else { p }.to_le_bytes());
        }

        info.resize(Config::LEN)?;

        // Conta menor precisa de menos aluguel; o excedente volta a quem pagou.
        let rent = Rent::get()?.minimum_balance(Config::LEN);
        let sobra = info.lamports().saturating_sub(rent);
        if sobra > 0 {
            move_lamports(&info, &ctx.accounts.authority.to_account_info(), sobra)?;
        }
        Ok(())
    }

    /// Ajusta a divisão do pote sem redeployar.
    ///
    /// As três fatias precisam somar exatamente 10_000, e o vencedor nunca
    /// pode cair abaixo de `MIN_WINNER_BPS`. Esse piso é a garantia que o
    /// jogador tem contra o operador: baixá-lo exige um binário novo, que é
    /// público e auditável — não basta uma transação discreta.
    pub fn set_splits(
        ctx: Context<AdminOnly>,
        winner_bps: u16,
        house_bps: u16,
        protocol_bps: u16,
    ) -> Result<()> {
        let soma = winner_bps as u64 + house_bps as u64 + protocol_bps as u64;
        require!(soma == BPS_DENOMINATOR, EscrowError::SplitsDoNotSum);
        require!(winner_bps >= MIN_WINNER_BPS, EscrowError::WinnerShareTooLow);

        let config = &mut ctx.accounts.config;
        config.winner_bps = winner_bps;
        config.house_bps = house_bps;
        config.protocol_bps = protocol_bps;

        emit!(SplitsChanged { winner_bps, house_bps, protocol_bps });
        Ok(())
    }

    /// Publica a procedência de uma versão da física.
    ///
    /// Ancora on-chain o que é preciso para reimplementar a simulação sem o
    /// nosso código: a impressão digital do comportamento, o hash do documento
    /// de especificação e onde ele está arquivado.
    ///
    /// IMUTÁVEL depois de criada, e isso é a garantia inteira. Se fosse
    /// editável, alguém poderia trocar a especificação depois de partidas
    /// terem sido jogadas — e replays antigos passariam a "provar" outra
    /// coisa. Especificação errada exige publicar uma VERSÃO NOVA da física,
    /// o que é público e deixa a antiga intacta.
    pub fn publish_provenance(
        ctx: Context<PublishProvenance>,
        engine_version: u16,
        physics_digest: [u8; 8],
        spec_hash: [u8; 32],
        spec_uri: String,
    ) -> Result<()> {
        require!(spec_uri.len() <= MAX_SPEC_URI_LEN, EscrowError::SpecUriTooLong);
        require!(!spec_uri.is_empty(), EscrowError::SpecUriTooLong);

        let p = &mut ctx.accounts.provenance;
        p.engine_version = engine_version;
        p.physics_digest = physics_digest;
        p.spec_hash = spec_hash;
        p.spec_uri = spec_uri;
        p.published_at = Clock::get()?.unix_timestamp;
        p.bump = ctx.bumps.provenance;

        emit!(ProvenancePublished {
            engine_version,
            physics_digest,
            spec_hash,
        });
        Ok(())
    }

    /// Cria os dois cofres. Roda uma vez.
    ///
    /// Cofres são PDAs do programa: não existe chave privada para perder nem
    /// para vazar. É a diferença entre um endereço que depende de um arquivo
    /// em disco e um que depende só do código publicado.
    pub fn init_vaults(ctx: Context<InitVaults>) -> Result<()> {
        let house = &mut ctx.accounts.house_vault;
        house.kind = VaultKind::House as u8;
        house.bump = ctx.bumps.house_vault;

        let treasury = &mut ctx.accounts.treasury_vault;
        treasury.kind = VaultKind::Treasury as u8;
        treasury.bump = ctx.bumps.treasury_vault;
        Ok(())
    }

    /// Retira do cofre da casa para custear a operação.
    ///
    /// Só a autoridade. O saldo mínimo de aluguel fica intocado, senão a conta
    /// seria coletada e a contabilidade histórica se perderia.
    pub fn withdraw_house(ctx: Context<WithdrawHouse>, amount: u64) -> Result<()> {
        let vault_info = ctx.accounts.house_vault.to_account_info();
        let disponivel = withdrawable(&vault_info)?;
        require!(amount > 0 && amount <= disponivel, EscrowError::InsufficientVaultBalance);

        move_lamports(&vault_info, &ctx.accounts.destination, amount)?;

        let vault = &mut ctx.accounts.house_vault;
        vault.total_out = vault.total_out.checked_add(amount).ok_or(EscrowError::MathOverflow)?;

        emit!(HouseWithdrawn {
            amount,
            destination: ctx.accounts.destination.key(),
            total_out: vault.total_out,
        });
        Ok(())
    }

    /// Queima do cofre de protocolo.
    ///
    /// Manda para o incinerador, que destrói os lamports de fato. Qualquer um
    /// pode chamar — a queima não beneficia quem aciona, e deixar aberto evita
    /// que a promessa de queima dependa de a operação estar viva.
    pub fn burn_treasury(ctx: Context<BurnTreasury>, amount: u64) -> Result<()> {
        require!(
            ctx.accounts.incinerator.key() == INCINERATOR,
            EscrowError::NotIncinerator
        );

        let vault_info = ctx.accounts.treasury_vault.to_account_info();
        let disponivel = withdrawable(&vault_info)?;
        require!(amount > 0 && amount <= disponivel, EscrowError::InsufficientVaultBalance);

        move_lamports(&vault_info, &ctx.accounts.incinerator, amount)?;

        let vault = &mut ctx.accounts.treasury_vault;
        vault.total_out = vault.total_out.checked_add(amount).ok_or(EscrowError::MathOverflow)?;

        emit!(TreasuryBurned { amount, total_burned: vault.total_out });
        Ok(())
    }
}

// ---------------------------------------------------------------- helpers

/// Divide o pote. O arredondamento sobra para o protocolo, nunca para o
/// vencedor — assim a soma nunca excede o pote e a conta não fica devedora.
fn split_pot(pot: u64, winner_bps: u16, house_bps: u16) -> Result<(u64, u64, u64)> {
    let prize = (pot as u128 * winner_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    let house = (pot as u128 * house_bps as u128 / BPS_DENOMINATOR as u128) as u64;
    let treasury = pot
        .checked_sub(prize)
        .and_then(|r| r.checked_sub(house))
        .ok_or(EscrowError::MathOverflow)?;
    Ok((prize, treasury, house))
}

/// Deposita do jogador para a conta da partida, via System Program.
fn deposit<'info>(
    from: &Signer<'info>,
    to: &AccountInfo<'info>,
    system_program: &Program<'info, System>,
    amount: u64,
) -> Result<()> {
    system_program::transfer(
        CpiContext::new(
            system_program.to_account_info(),
            system_program::Transfer {
                from: from.to_account_info(),
                to: to.clone(),
            },
        ),
        amount,
    )
}

/// Quanto dá para tirar de um cofre sem torná-lo coletável por falta de aluguel.
fn withdrawable(vault: &AccountInfo) -> Result<u64> {
    let rent = Rent::get()?.minimum_balance(vault.data_len());
    Ok(vault.lamports().saturating_sub(rent))
}

/// Move lamports de uma conta do programa para outra conta.
///
/// Não usa CPI porque a conta de origem pertence a este programa — mexer nos
/// lamports diretamente é o caminho correto e evita a restrição do System
/// Program de não transferir de contas com dados.
fn move_lamports<'info>(from: &AccountInfo<'info>, to: &AccountInfo<'info>, amount: u64) -> Result<()> {
    if amount == 0 {
        return Ok(());
    }
    let mut from_lamports = from.try_borrow_mut_lamports()?;
    let mut to_lamports = to.try_borrow_mut_lamports()?;

    **from_lamports = from_lamports
        .checked_sub(amount)
        .ok_or(EscrowError::InsufficientEscrowBalance)?;
    **to_lamports = to_lamports
        .checked_add(amount)
        .ok_or(EscrowError::MathOverflow)?;
    Ok(())
}

// ---------------------------------------------------------------- contas

#[account]
pub struct Config {
    pub authority: Pubkey,
    /// Chave que declara o vencedor. Ver docs/TDD.md §6.4 sobre a confiança
    /// que isso exige e o que a contrabalança.
    pub referee: Pubkey,
    pub min_stake: u64,
    pub max_stake: u64,
    pub paused: bool,
    pub bump: u8,
    /// Divisão do pote em basis points. Somam 10_000.
    pub winner_bps: u16,
    pub house_bps: u16,
    pub protocol_bps: u16,
}

impl Config {
    /// Layout original: tinha `house` e `treasury` como chaves soltas.
    pub const LEN_V1: usize = 8 + 32 * 4 + 8 * 2 + 1 + 1;
    /// V1 + os três campos de divisão do pote.
    pub const LEN_V2: usize = Self::LEN_V1 + 2 * 3;
    /// Atual: `house` e `treasury` saíram — os cofres viraram PDAs e aqueles
    /// dois endereços não eram lidos por ninguém.
    pub const LEN: usize = 8 + 32 * 2 + 8 * 2 + 1 + 1 + 2 * 3;

    /// Divisão efetiva. Um Config migrado de v1 tem zeros aqui; nesse caso
    /// vale o padrão, para nunca liquidar com 0% para o vencedor.
    pub fn splits(&self) -> (u16, u16, u16) {
        if self.winner_bps == 0 {
            (DEFAULT_WINNER_BPS, DEFAULT_HOUSE_BPS, DEFAULT_PROTOCOL_BPS)
        } else {
            (self.winner_bps, self.house_bps, self.protocol_bps)
        }
    }
}

#[account]
pub struct Game {
    pub match_id: [u8; 16],
    pub creator: Pubkey,
    pub opponent: Pubkey,
    pub stake: u64,
    pub state: u8,
    pub created_at: i64,
    pub deadline: i64,
    /**
     * Compromissos com os nonces que definem a quebra.
     *
     * Cada jogador escolhe 32 bytes em segredo e publica só o hash — AQUI, ao
     * depositar, antes de saber o do adversário. O seed da partida é
     * `sha256(nonce_criador ‖ nonce_oponente)`, e `settle_match` só aceita
     * nonces que batam com estes compromissos.
     *
     * Sem isso, nada on-chain amarrava o seed do replay a coisa nenhuma: o
     * referee escolhia o seed que quisesse e fabricava uma partida inteira que
     * nunca aconteceu, com o vencedor que quisesse. Foi demonstrado em duas
     * tentativas de busca aleatória.
     */
    pub commit_creator: [u8; 32],
    pub commit_opponent: [u8; 32],
    pub bump: u8,
}

impl Game {
    pub const LEN: usize = 8 + 16 + 32 * 2 + 8 + 1 + 8 * 2 + 32 * 2 + 1;
}

#[derive(Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum MatchState {
    Waiting = 0,
    Committed = 1,
}

// ---------------------------------------------------------------- contextos

#[derive(Accounts)]
pub struct Initialize<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = Config::LEN,
        seeds = [b"config"],
        bump
    )]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(match_id: [u8; 16])]
pub struct CreateMatch<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = creator,
        space = Game::LEN,
        seeds = [b"match", match_id.as_ref()],
        bump
    )]
    pub game: Account<'info, Game>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct JoinMatch<'info> {
    #[account(mut)]
    pub opponent: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        seeds = [b"match", game.match_id.as_ref()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CancelMatch<'info> {
    /// Antes do prazo precisa ser o criador; depois, qualquer um. A checagem
    /// está na instrução porque depende do relógio.
    pub signer: Signer<'info>,
    #[account(
        mut,
        close = creator,
        seeds = [b"match", game.match_id.as_ref()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    /// CHECK: validado contra `game.creator`; é para onde o depósito volta,
    /// independentemente de quem acionou o cancelamento.
    #[account(mut, address = game.creator @ EscrowError::CreatorAccountMismatch)]
    pub creator: AccountInfo<'info>,
}

#[derive(Accounts)]
#[instruction(winner: Pubkey, replay: Vec<u8>)]
pub struct SettleMatch<'info> {
    #[account(mut, address = config.referee @ EscrowError::NotReferee)]
    pub referee: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        mut,
        close = creator,
        seeds = [b"match", game.match_id.as_ref()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    /// CHECK: validado contra `game.creator`; recebe o rent no fechamento.
    #[account(mut, address = game.creator @ EscrowError::CreatorAccountMismatch)]
    pub creator: AccountInfo<'info>,
    /// CHECK: validado contra o argumento `winner` na instrução.
    #[account(mut)]
    pub winner: AccountInfo<'info>,
    #[account(mut, seeds = [b"treasury"], bump = treasury_vault.bump)]
    pub treasury_vault: Account<'info, Vault>,
    #[account(mut, seeds = [b"house"], bump = house_vault.bump)]
    pub house_vault: Account<'info, Vault>,
    /// Registro permanente. O referee paga o aluguel; é o custo de a partida
    /// ficar auditável para sempre.
    #[account(
        init,
        payer = referee,
        space = MatchRecordV2::space(replay.len()),
        seeds = [b"replay", game.match_id.as_ref()],
        bump
    )]
    pub record: Account<'info, MatchRecordV2>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimTimeout<'info> {
    /// Qualquer um pode acionar depois do prazo — de propósito.
    pub caller: Signer<'info>,
    #[account(
        mut,
        close = creator,
        seeds = [b"match", game.match_id.as_ref()],
        bump = game.bump
    )]
    pub game: Account<'info, Game>,
    /// CHECK: validado contra `game.creator`.
    #[account(mut, address = game.creator @ EscrowError::CreatorAccountMismatch)]
    pub creator: AccountInfo<'info>,
    /// CHECK: validado contra `game.opponent`.
    #[account(mut, address = game.opponent @ EscrowError::OpponentAccountMismatch)]
    pub opponent: AccountInfo<'info>,
}

/// Cofre do programa. PDA sem chave privada: o saldo só se move pelas regras
/// escritas aqui, e os totais permitem auditar quanto entrou e saiu sem varrer
/// o histórico de transações.
#[account]
pub struct Vault {
    pub kind: u8,
    /// Acumulado histórico recebido.
    pub total_in: u64,
    /// Acumulado histórico retirado (ou queimado, no caso do tesouro).
    pub total_out: u64,
    /// Só o cofre da casa usa. Quantas partidas foram liquidadas.
    pub matches_settled: u64,
    pub bump: u8,
}

impl Vault {
    pub const LEN: usize = 8 + 1 + 8 * 3 + 1;
}

#[derive(Clone, Copy)]
#[repr(u8)]
pub enum VaultKind {
    House = 0,
    Treasury = 1,
}

/**
 * Registro permanente de uma partida liquidada.
 *
 * Guarda o suficiente para qualquer pessoa reproduzir e conferir o resultado
 * sem depender de nenhum serviço nosso.
 */
#[account]
pub struct MatchRecordV2 {
    pub match_id: [u8; 16],
    pub winner: Pubkey,
    pub loser: Pubkey,
    /**
     * O criador da mesa é o VENCEDOR?
     *
     * O jogador 0 do replay é sempre o criador, e sem essa ligação o replay
     * era inauditável no ponto que mais importa: ele chama os jogadores de 0 e
     * 1, e a conta `Game`, que tinha o criador, é fechada na liquidação. Um
     * referee comprometido pagava o perdedor e a auditoria dizia "confere".
     *
     * Guardar a chave inteira seria redundante: o criador é necessariamente um
     * dos dois acima. Um bit basta, e economiza 32 bytes de estado permanente
     * em toda partida.
     */
    pub creator_won: bool,
    pub pot: u64,
    pub settled_at: i64,
    /**
     * Os nonces revelados, que geraram o seed da quebra.
     *
     * Ficam aqui para a auditoria ser completa sem depender da conta `Game`,
     * que é fechada: qualquer pessoa confere que
     * `seed == sha256(nonce_creator ‖ nonce_opponent)` e que cada nonce bate
     * com o compromisso que o contrato validou na liquidação.
     */
    pub nonce_creator: [u8; 32],
    pub nonce_opponent: [u8; 32],
    /// O replay em si: seed, tacos e todas as tacadas.
    pub replay: Vec<u8>,
    pub bump: u8,
}

impl MatchRecordV2 {
    /// Tamanho sem o replay. O `+ 4` é o prefixo de comprimento do `Vec`.
    pub const BASE_LEN: usize = 8 + 16 + 32 * 2 + 1 + 8 + 8 + 32 * 2 + 4 + 1;

    pub fn space(replay_len: usize) -> usize {
        Self::BASE_LEN + replay_len
    }
}

/**
 * Procedência de uma versão da física.
 *
 * Uma conta por versão. Quem tem um replay lê a versão dele, busca a conta
 * correspondente, e obtém tudo o que precisa para verificar por conta própria.
 */
#[account]
pub struct Provenance {
    pub engine_version: u16,
    /// Impressão digital do comportamento, em ASCII (ex.: "1751bd8c").
    pub physics_digest: [u8; 8],
    /// SHA-256 do documento de especificação.
    pub spec_hash: [u8; 32],
    /// Onde o documento está arquivado de forma permanente.
    pub spec_uri: String,
    pub published_at: i64,
    pub bump: u8,
}

impl Provenance {
    pub const BASE_LEN: usize = 8 + 2 + 8 + 32 + 4 + 8 + 1;

    pub fn space(uri_len: usize) -> usize {
        Self::BASE_LEN + uri_len
    }
}

#[derive(Accounts)]
#[instruction(engine_version: u16, physics_digest: [u8; 8], spec_hash: [u8; 32], spec_uri: String)]
pub struct PublishProvenance<'info> {
    #[account(mut, address = config.authority @ EscrowError::NotAuthority)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// Uma conta por versão: a v2 nasce ao lado da v1, sem apagá-la.
    #[account(
        init,
        payer = authority,
        space = Provenance::space(spec_uri.len()),
        seeds = [b"provenance".as_ref(), engine_version.to_le_bytes().as_ref()],
        bump
    )]
    pub provenance: Account<'info, Provenance>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct MigrateConfig<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: discriminador e autoridade conferidos dentro da instrução; não
    /// dá para usar `Account<Config>` aqui porque a conta ainda tem o tamanho
    /// antigo e a desserialização falharia antes do realloc.
    #[account(mut, seeds = [b"config"], bump)]
    pub config: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitVaults<'info> {
    #[account(mut, address = config.authority @ EscrowError::NotAuthority)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(
        init,
        payer = authority,
        space = Vault::LEN,
        seeds = [b"house"],
        bump
    )]
    pub house_vault: Account<'info, Vault>,
    #[account(
        init,
        payer = authority,
        space = Vault::LEN,
        seeds = [b"treasury"],
        bump
    )]
    pub treasury_vault: Account<'info, Vault>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WithdrawHouse<'info> {
    #[account(address = config.authority @ EscrowError::NotAuthority)]
    pub authority: Signer<'info>,
    #[account(seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    #[account(mut, seeds = [b"house"], bump = house_vault.bump)]
    pub house_vault: Account<'info, Vault>,
    /// CHECK: destino escolhido pela autoridade; não há o que validar aqui.
    #[account(mut)]
    pub destination: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct BurnTreasury<'info> {
    /// Qualquer um pode acionar a queima — ela não beneficia quem chama.
    pub caller: Signer<'info>,
    #[account(mut, seeds = [b"treasury"], bump = treasury_vault.bump)]
    pub treasury_vault: Account<'info, Vault>,
    /// CHECK: comparado com o incinerador oficial dentro da instrução.
    #[account(mut)]
    pub incinerator: AccountInfo<'info>,
}

#[derive(Accounts)]
pub struct AdminOnly<'info> {
    #[account(address = config.authority @ EscrowError::NotAuthority)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
}

// ---------------------------------------------------------------- eventos

#[event]
pub struct MatchSettled {
    pub match_id: [u8; 16],
    pub winner: Pubkey,
    pub pot: u64,
    pub prize: u64,
    pub treasury: u64,
    pub house: u64,
    /**
     * Hash do replay, calculado na liquidação.
     *
     * Não fica guardado na conta: o replay está lá inteiro, e o hash dele é
     * recalculável. Vai no evento porque quem escuta a chain não tem a conta
     * em mãos.
     */
    pub result_hash: [u8; 32],
}

#[event]
pub struct ProvenancePublished {
    pub engine_version: u16,
    pub physics_digest: [u8; 8],
    pub spec_hash: [u8; 32],
}

#[event]
pub struct SplitsChanged {
    pub winner_bps: u16,
    pub house_bps: u16,
    pub protocol_bps: u16,
}

#[event]
pub struct HouseWithdrawn {
    pub amount: u64,
    pub destination: Pubkey,
    pub total_out: u64,
}

#[event]
pub struct TreasuryBurned {
    pub amount: u64,
    pub total_burned: u64,
}

/// A partida ficou com os dois depósitos e o relógio dela começou.
#[event]
pub struct MatchCommitted {
    pub match_id: [u8; 16],
    pub deadline: i64,
}

/**
 * A configuração de operação mudou.
 *
 * A troca de referee é a mudança mais perigosa que a autoridade pode fazer —
 * quem assina as liquidações passa a ser outro. Era a única que não deixava
 * rastro em evento, enquanto `set_splits` e os saques deixavam.
 */
#[event]
pub struct ConfigChanged {
    pub referee: Pubkey,
    pub min_stake: u64,
    pub max_stake: u64,
}

/// A autoridade do programa mudou de mãos.
#[event]
pub struct AuthorityChanged {
    pub previous: Pubkey,
    pub current: Pubkey,
}

#[event]
pub struct MatchRefunded {
    pub match_id: [u8; 16],
    pub stake: u64,
}

// ---------------------------------------------------------------- erros

#[error_code]
pub enum EscrowError {
    #[msg("Faixa de valores inválida.")]
    InvalidStakeRange,
    #[msg("Valor de entrada fora dos limites.")]
    StakeOutOfRange,
    #[msg("Prazo inválido.")]
    InvalidTimeout,
    #[msg("O programa está pausado.")]
    Paused,
    #[msg("Esta mesa não aceita mais jogadores.")]
    NotJoinable,
    #[msg("Você não pode entrar na própria mesa.")]
    CannotJoinOwnMatch,
    #[msg("Esta mesa expirou.")]
    MatchExpired,
    #[msg("Só é possível cancelar antes de alguém entrar.")]
    NotCancellable,
    #[msg("Esta partida não está em estado de liquidação.")]
    NotSettleable,
    #[msg("O pote não cobre o aluguel do registro permanente do replay.")]
    PotTooSmallForRecord,
    #[msg("O nonce revelado não corresponde ao compromisso feito no depósito.")]
    BadReveal,
    #[msg("O vencedor não é um dos jogadores desta partida.")]
    WinnerNotInMatch,
    #[msg("A conta do vencedor não confere com o vencedor declarado.")]
    WinnerAccountMismatch,
    #[msg("A conta do criador não confere.")]
    CreatorAccountMismatch,
    #[msg("A conta do oponente não confere.")]
    OpponentAccountMismatch,
    #[msg("Conta de tesouro inválida.")]
    TreasuryMismatch,
    #[msg("Conta da casa inválida.")]
    HouseMismatch,
    #[msg("Apenas o criador pode fazer isso.")]
    NotCreator,
    #[msg("Apenas o referee pode liquidar.")]
    NotReferee,
    #[msg("Apenas a autoridade pode fazer isso.")]
    NotAuthority,
    #[msg("O prazo ainda não estourou.")]
    NotExpiredYet,
    #[msg("Esta partida não é reembolsável.")]
    NotRefundable,
    #[msg("Saldo insuficiente no escrow.")]
    InsufficientEscrowBalance,
    #[msg("Saldo insuficiente no cofre.")]
    InsufficientVaultBalance,
    #[msg("A conta informada não é o incinerador da Solana.")]
    NotIncinerator,
    #[msg("A conta informada não é o Config deste programa.")]
    NotConfigAccount,
    #[msg("O replay passa do tamanho máximo permitido.")]
    ReplayTooLarge,
    #[msg("Endereço da especificação vazio ou longo demais.")]
    SpecUriTooLong,
    #[msg("As fatias precisam somar exatamente 100%.")]
    SplitsDoNotSum,
    #[msg("A fatia do vencedor está abaixo do mínimo permitido pelo programa.")]
    WinnerShareTooLow,
    #[msg("Estouro aritmético.")]
    MathOverflow,
}
