import { describe, expect, test } from 'bun:test'
import { FakeChain } from '@/chain'
import { Lobby, LobbyError } from '@/lobby'
import { parseAmount } from '@zinc-pool/protocol'
import { Keypair, PublicKey } from '@solana/web3.js'

const ALICE = Keypair.generate().publicKey.toBase58()
const BOB = Keypair.generate().publicKey.toBase58()
const CARLA = Keypair.generate().publicKey.toBase58()

const ONE = parseAmount('1')!
const NOW = 1_700_000_000_000

function setup() {
  const chain = new FakeChain()
  return { chain, lobby: new Lobby(chain) }
}

const unhex = (h: string) => Uint8Array.from(Buffer.from(h, 'hex'))

/** Simula o que a carteira do jogador faria: criar a conta on-chain. */
function simulateDeposit(
  chain: FakeChain,
  matchIdHex: string,
  creator: string,
  stake: bigint,
  opponent?: string,
) {
  chain.setMatch(unhex(matchIdHex), {
    matchId: unhex(matchIdHex),
    creator: new PublicKey(creator),
    opponent: opponent ? new PublicKey(opponent) : null,
    stake,
    state: opponent ? 'committed' : 'waiting',
    createdAt: NOW / 1000,
    deadline: NOW / 1000 + 3600,
  })
}

/** Caminho feliz completo de criação, usado como preparação em vários testes. */
async function createRoom(chain: FakeChain, lobby: Lobby, creator = ALICE, stake = ONE) {
  const reservation = await lobby.reserve(creator, stake, 'Mesa', 'eightball', NOW)
  simulateDeposit(chain, reservation.matchIdHex, creator, stake)
  return lobby.confirmCreate(creator, reservation.matchIdHex, NOW)
}

describe('Lobby — criação', () => {
  test('a sala só existe depois do depósito confirmado na chain', async () => {
    const { chain, lobby } = setup()

    const reservation = await lobby.reserve(ALICE, ONE, 'Mesa da Alice', 'eightball', NOW)
    // Reservou, mas ninguém depositou ainda: nada é publicado.
    expect(lobby.openRooms()).toHaveLength(0)
    expect(lobby.roomOf(ALICE)).toBeNull()

    simulateDeposit(chain, reservation.matchIdHex, ALICE, ONE)
    const room = await lobby.confirmCreate(ALICE, reservation.matchIdHex, NOW)

    expect(room.state).toBe('waiting')
    expect(room.creator).toBe(ALICE)
    expect(lobby.openRooms()).toHaveLength(1)
  })

  test('sem depósito on-chain, confirmar falha e nada é publicado', async () => {
    const { lobby } = setup()
    const reservation = await lobby.reserve(ALICE, ONE, '', 'eightball', NOW)

    await expect(lobby.confirmCreate(ALICE, reservation.matchIdHex, NOW)).rejects.toMatchObject({
      code: 'deposit_not_found',
    })
    expect(lobby.openRooms()).toHaveLength(0)
  })

  test('depósito de valor diferente do reservado é recusado', async () => {
    const { chain, lobby } = setup()
    const reservation = await lobby.reserve(ALICE, ONE, '', 'eightball', NOW)
    // Jogador depositou menos do que declarou.
    simulateDeposit(chain, reservation.matchIdHex, ALICE, ONE / 2n)

    await expect(lobby.confirmCreate(ALICE, reservation.matchIdHex, NOW)).rejects.toMatchObject({
      code: 'deposit_mismatch',
    })
    expect(lobby.openRooms()).toHaveLength(0)
  })

  test('não dá para confirmar o depósito de outra pessoa como seu', async () => {
    const { chain, lobby } = setup()
    const reservation = await lobby.reserve(ALICE, ONE, '', 'eightball', NOW)
    // A conta on-chain existe, mas quem depositou foi a Carla.
    simulateDeposit(chain, reservation.matchIdHex, CARLA, ONE)

    await expect(lobby.confirmCreate(ALICE, reservation.matchIdHex, NOW)).rejects.toMatchObject({
      code: 'deposit_mismatch',
    })
  })

  test('confirmar com match_id que não foi reservado é recusado', async () => {
    const { chain, lobby } = setup()
    const forged = 'ff'.repeat(16)
    simulateDeposit(chain, forged, ALICE, ONE)

    await expect(lobby.confirmCreate(ALICE, forged, NOW)).rejects.toMatchObject({
      code: 'no_reservation',
    })
  })

  test('valor fora dos limites nem chega a reservar', async () => {
    const { lobby } = setup()
    await expect(lobby.reserve(ALICE, 1n, '', 'eightball', NOW)).rejects.toThrow(LobbyError)
    await expect(lobby.reserve(ALICE, parseAmount('999')!, '', 'eightball', NOW)).rejects.toThrow(LobbyError)
  })

  test('os limites vêm da chain, não de constante local', async () => {
    const { chain, lobby } = setup()
    // O Config on-chain passa a exigir entrada bem maior.
    chain.limits = { minStake: parseAmount('2')!, maxStake: parseAmount('10')! }

    await expect(lobby.reserve(ALICE, ONE, '', 'eightball', NOW)).rejects.toMatchObject({
      code: 'stake_out_of_range',
    })
    await expect(lobby.reserve(ALICE, parseAmount('3')!, '', 'eightball', NOW)).resolves.toBeDefined()
  })

  test('um jogador, uma sala por vez', async () => {
    const { chain, lobby } = setup()
    await createRoom(chain, lobby)
    await expect(lobby.reserve(ALICE, ONE, '', 'eightball', NOW)).rejects.toThrow(LobbyError)
  })
})

describe('Lobby — entrada', () => {
  test('entrar confirma o oponente pela chain e fecha a mesa', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)

    lobby.requestJoin(BOB, room.id, NOW)
    simulateDeposit(chain, room.matchId, ALICE, ONE, BOB)
    const joined = await lobby.confirmJoin(BOB, room.id)

    expect(joined.state).toBe('committed')
    expect(joined.opponent).toBe(BOB)
    expect(lobby.openRooms()).toHaveLength(0)
  })

  test('se a chain ainda mostra waiting, a entrada não confirma', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)
    lobby.requestJoin(BOB, room.id, NOW)
    // Bob diz que entrou, mas a transação dele não confirmou.

    await expect(lobby.confirmJoin(BOB, room.id)).rejects.toMatchObject({
      code: 'deposit_not_found',
    })
    expect(lobby.get(room.id)?.state).toBe('waiting')
  })

  test('não dá para reivindicar a entrada de outro jogador', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)

    lobby.requestJoin(BOB, room.id, NOW)
    lobby.requestJoin(CARLA, room.id, NOW)
    // Quem realmente entrou on-chain foi a Carla.
    simulateDeposit(chain, room.matchId, ALICE, ONE, CARLA)

    await expect(lobby.confirmJoin(BOB, room.id)).rejects.toMatchObject({
      code: 'deposit_mismatch',
    })
    await expect(lobby.confirmJoin(CARLA, room.id)).resolves.toMatchObject({ opponent: CARLA })
  })

  test('terceiro não entra em mesa comprometida', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)
    lobby.requestJoin(BOB, room.id, NOW)
    simulateDeposit(chain, room.matchId, ALICE, ONE, BOB)
    await lobby.confirmJoin(BOB, room.id)

    expect(() => lobby.requestJoin(CARLA, room.id, NOW)).toThrow(LobbyError)
  })

  test('criador não entra na própria mesa', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)
    expect(() => lobby.requestJoin(ALICE, room.id, NOW)).toThrow(LobbyError)
  })
})

describe('Lobby — cancelamento', () => {
  test('cancelar só sincroniza depois que a conta some da chain', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)

    // Cliente afirma ter cancelado, mas a conta continua lá.
    await expect(lobby.confirmCancel(ALICE, room.id)).rejects.toMatchObject({
      code: 'deposit_mismatch',
    })
    expect(lobby.openRooms()).toHaveLength(1)

    chain.removeMatch(unhex(room.matchId))
    await lobby.confirmCancel(ALICE, room.id)

    expect(lobby.openRooms()).toHaveLength(0)
    expect(lobby.roomOf(ALICE)).toBeNull()
  })

  test('só o criador cancela', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)
    chain.removeMatch(unhex(room.matchId))

    await expect(lobby.confirmCancel(BOB, room.id)).rejects.toMatchObject({
      code: 'not_room_creator',
    })
  })

  test('mesa comprometida não pode ser cancelada', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)
    lobby.requestJoin(BOB, room.id, NOW)
    simulateDeposit(chain, room.matchId, ALICE, ONE, BOB)
    await lobby.confirmJoin(BOB, room.id)

    await expect(lobby.confirmCancel(ALICE, room.id)).rejects.toThrow(LobbyError)
  })
})

describe('Lobby — expiração', () => {
  test('mesa expirada só sai da lista se o depósito já saiu da chain', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)

    // Passou do prazo, mas o dinheiro ainda está na PDA: a sala permanece
    // visível, porque é onde o criador aciona o cancelamento.
    expect(await lobby.sweep(room.expiresAt + 1)).toBe(0)
    expect(lobby.openRooms()).toHaveLength(1)

    chain.removeMatch(unhex(room.matchId))
    expect(await lobby.sweep(room.expiresAt + 1)).toBe(1)
    expect(lobby.openRooms()).toHaveLength(0)
  })

  test('sweep não toca em mesa comprometida', async () => {
    const { chain, lobby } = setup()
    const room = await createRoom(chain, lobby)
    lobby.requestJoin(BOB, room.id, NOW)
    simulateDeposit(chain, room.matchId, ALICE, ONE, BOB)
    await lobby.confirmJoin(BOB, room.id)

    expect(await lobby.sweep(room.expiresAt + 1)).toBe(0)
    expect(lobby.get(room.id)?.state).toBe('committed')
  })

  test('reserva não confirmada expira e libera o jogador', async () => {
    const { lobby } = setup()
    await lobby.reserve(ALICE, ONE, '', 'eightball', NOW)

    await lobby.sweep(NOW + 4 * 60 * 1000)

    // Como a reserva sumiu, dá para reservar de novo sem ficar preso.
    await expect(lobby.reserve(ALICE, ONE, '', 'eightball', NOW + 4 * 60 * 1000)).resolves.toBeDefined()
  })
})

describe('modalidade da mesa', () => {
  test('a sala carrega a modalidade escolhida', async () => {
    const { chain, lobby } = setup()
    const r = await lobby.reserve(ALICE, ONE, 'Sinuca', 'sinuca', NOW)
    simulateDeposit(chain, r.matchIdHex, ALICE, ONE)

    const room = await lobby.confirmCreate(ALICE, r.matchIdHex, NOW)
    expect(room.mode).toBe('sinuca')
  })

  test('quem entra joga a modalidade da sala, não a sua', async () => {
    // Descobrir a modalidade só depois de o dinheiro estar no contrato seria
    // uma armadilha: ela é anunciada antes do depósito e não muda.
    const { chain, lobby } = setup()
    const r = await lobby.reserve(ALICE, ONE, 'Sinuca', 'sinuca', NOW)
    simulateDeposit(chain, r.matchIdHex, ALICE, ONE)
    const room = await lobby.confirmCreate(ALICE, r.matchIdHex, NOW)

    await lobby.requestJoin(BOB, room.id, NOW)
    simulateDeposit(chain, r.matchIdHex, ALICE, ONE, BOB)

    const fechada = await lobby.confirmJoin(BOB, room.id)
    expect(fechada.mode).toBe('sinuca')
  })

  test('as duas modalidades atravessam a reserva', async () => {
    for (const modo of ['eightball', 'sinuca'] as const) {
      const { lobby } = setup()
      expect((await lobby.reserve(ALICE, ONE, '', modo, NOW)).mode).toBe(modo)
    }
  })
})
