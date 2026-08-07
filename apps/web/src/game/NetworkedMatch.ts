import type { MatchController } from '@/game/objects/MatchController'
import type { GameClient, MatchMessage } from '@/net/client'
import type { GameModeId } from '@zinc-pool/engine-rules'
import { decodeReplay } from '@zinc-pool/replay'

/**
 * Cola entre o servidor e a cena.
 *
 * Fica de fora da `MatchController` de propósito: a mesa não precisa saber o
 * que é um WebSocket, e a hotseat continua funcionando sem nada disto. O que
 * este módulo faz é traduzir mensagens em chamadas — e cuidar da parte que
 * nenhuma das duas pontas resolve sozinha, que é a ORDEM.
 *
 * O ciclo tem uma sequência obrigatória e ela é imposta pelo servidor:
 *
 *   match.begin      → o cliente sorteia o nonce e manda só o hash
 *   match.reveal.open→ os dois se comprometeram; agora pode revelar
 *   match.start      → o seed saiu; a mesa é armada e a partida começa
 *   match.shot ×N    → cada tacada, com o hash do estado resultante
 *   match.end        → acabou; o replay vem junto para conferência
 *
 * A mesa só existe a partir de `match.start`, porque antes disso o seed da
 * quebra ainda não foi definido — armá-la antes seria montar um triângulo que
 * o servidor não reconheceria.
 */

export type NetMatchState = {
  fase: 'aguardando' | 'comprometendo' | 'revelando' | 'jogando' | 'terminada'
  /** Índice deste jogador na partida. */
  you: 0 | 1 | null
  opponent: string | null
  mode: GameModeId
  /** De quem é a vez, pelo servidor. */
  turn: 0 | 1 | null
  /** Quando o prazo da vez expira, em ms. */
  deadline: number | null
  /** Escolha aberta, se houver. */
  decision: { chooser: 0 | 1; kind: string; options: { index: number; label: string }[] } | null
  /** Bola na mão aberta, se houver. */
  ballInHand: { who: 0 | 1; region: 'anywhere' | 'kitchen' } | null
  /** A tacada da vez exige declarar a caçapa. */
  callRequired: boolean
  opponentOffline: boolean
  resultado: { winner: 0 | 1 | null; reason: string } | null
  /** Assinatura da liquidação, quando ela chega. */
  liquidacao: { signature: string | null; reason: string | null } | null
  /** Divergência entre a nossa mesa e a do servidor. */
  desync: string | null
  mensagem: string | null
}

const INICIAL: NetMatchState = {
  fase: 'aguardando',
  you: null,
  opponent: null,
  mode: 'eightball',
  turn: null,
  deadline: null,
  decision: null,
  ballInHand: null,
  callRequired: false,
  opponentOffline: false,
  resultado: null,
  liquidacao: null,
  desync: null,
  mensagem: null,
}

export type NetworkedMatchHandle = {
  state: NetMatchState
  subscribe(l: (s: NetMatchState) => void): () => void
  /** Chamado quando o seed chega; quem monta a cena cria a mesa aqui. */
  dispose(): void
}

export function connectMatch(
  client: GameClient,
  /** Cria a mesa com o seed do servidor. Só é chamado uma vez. */
  criarMesa: (mode: GameModeId, seed: Uint8Array, you: 0 | 1) => MatchController,
): NetworkedMatchHandle {
  let state: NetMatchState = { ...INICIAL }
  let matchId: string | null = null
  let controller: MatchController | null = null
  const listeners = new Set<(s: NetMatchState) => void>()

  const patch = (p: Partial<NetMatchState>): void => {
    state = { ...state, ...p }
    for (const l of listeners) l(state)
  }

  const desinscrever = client.onMatch((msg: MatchMessage) => {
    switch (msg.t) {
      case 'match.begin': {
        matchId = msg.matchId
        patch({
          fase: 'comprometendo',
          you: msg.you,
          opponent: msg.opponent,
          mode: msg.mode,
          mensagem: 'Combinando a quebra com o adversário…',
        })
        // O compromisso sai automaticamente: é sorteio, não decisão do
        // jogador, e pedir um clique aqui só atrasaria a partida. Reenviar o
        // mesmo compromisso ao reconectar é inofensivo — o servidor recusa o
        // segundo e mantém o primeiro, que é o que o nonce guardado combina.
        client.commitBreak(msg.matchId)
        break
      }

      case 'match.reveal.open':
        patch({ fase: 'revelando' })
        if (matchId) client.revealBreak(matchId)
        break

      case 'match.start': {
        const seed = fromHex(msg.seed)
        controller = criarMesa(state.mode, seed, state.you ?? 0)
        controller.net = {
          you: state.you ?? 0,
          submit: (shot, call) => client.shoot(shot, call),
          submitPlacement: (p) => client.place(p.x, p.y),
        }
        patch({
          fase: 'jogando',
          turn: msg.turn,
          deadline: msg.deadline,
          mensagem: null,
        })
        break
      }

      case 'match.history': {
        // Chegou no meio: a mesa foi armada na quebra pelo `match.start` e
        // agora avança até onde a partida está de verdade.
        const r = decodeReplay(fromHex(msg.replay))
        controller?.catchUp(r.shots, r.decisions, r.placements)
        patch({ turn: msg.turn, deadline: msg.deadline, mensagem: 'Partida retomada.' })
        break
      }

      case 'match.shot': {
        // A tacada do RELÓGIO ninguém previu — nem o jogador que deixou o tempo
        // acabar. Tratá-la como própria faria a mesa dele parar no estado
        // anterior, e a tacada seguinte seria recusada pela física.
        controller?.applyRemoteShot(
          msg.by,
          { angle: msg.angle, power: msg.power, spinX: msg.spinX, spinY: msg.spinY },
          msg.stateHash,
          msg.byClock === true,
        )
        patch({
          turn: msg.turn,
          deadline: msg.deadline,
          decision: null,
          callRequired: false,
          desync: controller?.desync ?? null,
          mensagem: msg.status,
        })
        break
      }

      case 'match.callRequired':
        patch({ callRequired: true })
        break

      case 'match.ballInHand':
        patch({
          ballInHand: { who: msg.who, region: msg.region },
          deadline: msg.deadline,
        })
        break

      case 'match.placed': {
        // A nossa própria já foi aplicada por previsão — exceto quando quem
        // colocou foi o relógio, no ponto de saque, porque o tempo acabou.
        if (msg.by !== state.you || msg.byClock === true) {
          controller?.applyRemotePlacement(msg.x, msg.y)
        }
        patch({ ballInHand: null, deadline: msg.deadline })
        break
      }

      case 'match.decision':
        patch({
          decision: { chooser: msg.chooser, kind: msg.kind, options: [...msg.options] },
          deadline: msg.deadline,
        })
        break

      case 'match.decided': {
        // A escolha é aplicada na nossa mesa pelo mesmo caminho do servidor,
        // inclusive quando foi o adversário quem escolheu.
        controller?.choose(msg.option)
        patch({ decision: null, turn: msg.turn, deadline: msg.deadline })
        break
      }

      case 'match.opponentOffline':
        patch({
          opponentOffline: true,
          mensagem: 'Adversário desconectou — a vez dele vai passando.',
        })
        break

      case 'match.opponentOnline':
        patch({ opponentOffline: false, mensagem: 'Adversário voltou.' })
        break

      case 'match.settled':
        patch({ liquidacao: { signature: msg.signature, reason: msg.reason } })
        break

      case 'match.end':
        // O segredo não serve mais e não deve ficar no navegador.
        if (matchId) client.forgetNonce(matchId)
        patch({
          fase: 'terminada',
          resultado: { winner: msg.winner, reason: msg.reason },
          deadline: null,
          decision: null,
        })
        break
    }
  })

  return {
    get state() {
      return state
    },
    subscribe(l) {
      listeners.add(l)
      l(state)
      return () => listeners.delete(l)
    },
    dispose: desinscrever,
  }
}

const fromHex = (hex: string): Uint8Array =>
  Uint8Array.from(hex.match(/.{2}/g)?.map((b) => Number.parseInt(b, 16)) ?? [])
