import { randomBytes } from 'node:crypto'
import type { Chain } from '@/chain'
import { MATCH_TIMEOUT_SECONDS, ROOM_TTL_MS } from '@/config'
import type { ErrorCode, GameMode, Room } from '@zinc-pool/protocol'
import { PublicKey } from '@solana/web3.js'

export class LobbyError extends Error {
  constructor(
    readonly code: ErrorCode,
    message: string,
  ) {
    super(message)
    this.name = 'LobbyError'
  }
}

export type LobbyEvent = { t: 'upsert'; room: Room } | { t: 'remove'; roomId: string }

type Reservation = {
  matchId: Uint8Array
  matchIdHex: string
  address: string
  stake: bigint
  label: string
  mode: GameMode
  action: 'create' | 'join'
  createdAt: number
}

/** Reserva sem confirmação some depois disso — o jogador desistiu ou fechou a aba. */
const RESERVATION_TTL_MS = 3 * 60 * 1000

const hex = (bytes: Uint8Array): string => Buffer.from(bytes).toString('hex')
const unhex = (value: string): Uint8Array => Uint8Array.from(Buffer.from(value, 'hex'))

/**
 * Registro de salas.
 *
 * A diferença essencial em relação a um lobby comum: este não guarda saldo nem
 * move dinheiro. Uma sala só existe depois que o servidor LEU na blockchain
 * que o depósito está lá. O caminho é sempre reservar → jogador assina →
 * servidor confirma na chain.
 *
 * `roomId` é o `match_id` em hex, então a sala e a conta on-chain têm a mesma
 * identidade — não há como confundir uma com a outra.
 */
export class Lobby {
  #rooms = new Map<string, Room>()
  /** address → roomId. Um jogador, uma sala. */
  #playerRoom = new Map<string, string>()
  /** address → reserva pendente de confirmação. */
  #reservations = new Map<string, Reservation>()
  #listeners = new Set<(event: LobbyEvent) => void>()

  constructor(private readonly chain: Chain) {}

  subscribe(listener: (event: LobbyEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #emit(event: LobbyEvent): void {
    for (const l of this.#listeners) l(event)
  }

  openRooms(): Room[] {
    return [...this.#rooms.values()]
      .filter((r) => r.state === 'waiting')
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  roomOf(address: string): Room | null {
    const id = this.#playerRoom.get(address)
    return id ? (this.#rooms.get(id) ?? null) : null
  }

  get(roomId: string): Room | null {
    return this.#rooms.get(roomId) ?? null
  }

  // ------------------------------------------------------------ criar

  /**
   * Passo 1: reserva um match_id. Nada acontece on-chain aqui — é só o
   * servidor dizendo ao cliente o que assinar.
   */
  async reserve(
    address: string,
    stake: bigint,
    label: string,
    mode: GameMode,
    now: number,
  ): Promise<Reservation> {
    // Os limites vêm da chain, não de uma cópia local: aceitar aqui o que o
    // programa recusaria faria o jogador assinar uma transação condenada.
    const { minStake, maxStake } = await this.chain.getLimits()
    if (stake < minStake || stake > maxStake) {
      throw new LobbyError('stake_out_of_range', 'Valor de entrada fora dos limites.')
    }
    if (this.#playerRoom.has(address)) {
      throw new LobbyError('already_in_room', 'Você já está em uma sala.')
    }

    const matchId = Uint8Array.from(randomBytes(16))
    const reservation: Reservation = {
      matchId,
      matchIdHex: hex(matchId),
      address,
      stake,
      label: label.trim().slice(0, 24) || 'Mesa',
      mode,
      action: 'create',
      createdAt: now,
    }
    this.#reservations.set(address, reservation)
    return reservation
  }

  /**
   * Passo 2: o jogador diz que depositou. O servidor confere na chain.
   *
   * Nada aqui confia no cliente: se a conta não existir, ou o criador não for
   * ele, ou o valor não bater com o reservado, a sala não é publicada.
   */
  async confirmCreate(address: string, matchIdHex: string, now: number): Promise<Room> {
    const reservation = this.#reservations.get(address)
    if (!reservation || reservation.matchIdHex !== matchIdHex || reservation.action !== 'create') {
      throw new LobbyError('no_reservation', 'Nenhuma reserva de mesa para confirmar.')
    }

    const onChain = await this.#readMatch(reservation.matchId)
    if (!onChain) {
      throw new LobbyError('deposit_not_found', 'Depósito não encontrado na blockchain.')
    }
    if (onChain.creator.toBase58() !== address) {
      throw new LobbyError('deposit_mismatch', 'O depósito foi feito por outra carteira.')
    }
    if (onChain.stake !== reservation.stake) {
      throw new LobbyError('deposit_mismatch', 'O valor depositado não confere com o reservado.')
    }

    this.#reservations.delete(address)

    const room: Room = {
      id: reservation.matchIdHex,
      matchId: reservation.matchIdHex,
      label: reservation.label,
      mode: reservation.mode,
      creator: address,
      opponent: null,
      stake: onChain.stake.toString(),
      state: 'waiting',
      createdAt: now,
      expiresAt: now + ROOM_TTL_MS,
    }

    this.#rooms.set(room.id, room)
    this.#playerRoom.set(address, room.id)
    this.#emit({ t: 'upsert', room })
    return room
  }

  // ------------------------------------------------------------ entrar

  /** Passo 1 de entrar: valida que a sala aceita e devolve o que assinar. */
  requestJoin(address: string, roomId: string, now: number): Reservation {
    const room = this.#rooms.get(roomId)
    if (!room) throw new LobbyError('room_not_found', 'Sala não encontrada.')
    if (room.state !== 'waiting' || room.opponent) {
      throw new LobbyError('room_not_joinable', 'Esta sala não aceita mais jogadores.')
    }
    if (room.creator === address) {
      throw new LobbyError('room_not_joinable', 'Você não pode entrar na própria mesa.')
    }
    if (this.#playerRoom.has(address)) {
      throw new LobbyError('already_in_room', 'Você já está em uma sala.')
    }

    const reservation: Reservation = {
      matchId: unhex(room.matchId),
      matchIdHex: room.matchId,
      address,
      stake: BigInt(room.stake),
      label: room.label,
      // Quem entra joga a modalidade da SALA, não a que escolheria: é o que
      // estava anunciado quando ele decidiu depositar.
      mode: room.mode,
      action: 'join',
      createdAt: now,
    }
    this.#reservations.set(address, reservation)
    return reservation
  }

  /** Passo 2 de entrar: confere na chain que o oponente é ele mesmo. */
  async confirmJoin(address: string, roomId: string): Promise<Room> {
    const reservation = this.#reservations.get(address)
    if (!reservation || reservation.matchIdHex !== roomId || reservation.action !== 'join') {
      throw new LobbyError('no_reservation', 'Nenhuma reserva de entrada para confirmar.')
    }

    const room = this.#rooms.get(roomId)
    if (!room) throw new LobbyError('room_not_found', 'Sala não encontrada.')

    const onChain = await this.#readMatch(reservation.matchId)
    if (!onChain) {
      throw new LobbyError('deposit_not_found', 'Partida não encontrada na blockchain.')
    }
    if (onChain.state !== 'committed') {
      throw new LobbyError('deposit_not_found', 'O depósito do oponente ainda não confirmou.')
    }
    if (onChain.opponent?.toBase58() !== address) {
      throw new LobbyError('deposit_mismatch', 'Quem entrou na partida foi outra carteira.')
    }

    this.#reservations.delete(address)

    const updated: Room = { ...room, opponent: address, state: 'committed' }
    this.#rooms.set(room.id, updated)
    this.#playerRoom.set(address, room.id)
    this.#emit({ t: 'upsert', room: updated })
    this.#emit({ t: 'remove', roomId: room.id })
    return updated
  }

  // --------------------------------------------------------- cancelar

  /**
   * O jogador cancelou on-chain; sincroniza o lobby.
   *
   * A verdade é a chain: se a conta ainda existir, o cancelamento não
   * aconteceu e a sala continua de pé, por mais que o cliente afirme.
   */
  async confirmCancel(address: string, roomId: string): Promise<void> {
    const room = this.#rooms.get(roomId)
    if (!room) throw new LobbyError('room_not_found', 'Sala não encontrada.')
    if (room.creator !== address) {
      throw new LobbyError('not_room_creator', 'Só quem criou pode cancelar.')
    }
    if (room.state !== 'waiting') {
      throw new LobbyError('room_not_joinable', 'A mesa já está comprometida.')
    }

    const onChain = await this.#readMatch(unhex(room.matchId))
    if (onChain) {
      throw new LobbyError('deposit_mismatch', 'A partida ainda existe na blockchain.')
    }

    this.#close(room)
  }

  /**
   * Tira da listagem as salas que passaram do prazo sem oponente.
   *
   * O servidor NÃO devolve o depósito — não tem como, não é ele quem assina.
   * O dinheiro continua na PDA e o criador pode cancelar quando quiser. Depois
   * do prazo on-chain, qualquer um pode acionar o cancelamento e o valor volta
   * para o criador de qualquer forma.
   */
  async sweep(now: number): Promise<number> {
    const expired = [...this.#rooms.values()].filter(
      (r) => r.state === 'waiting' && r.expiresAt <= now,
    )

    let removed = 0
    for (const room of expired) {
      // Se o criador já cancelou on-chain, some de vez. Se não, mantemos a
      // sala visível para ele — é onde está o botão de cancelar.
      const onChain = await this.#readMatch(unhex(room.matchId)).catch(() => null)
      if (!onChain) {
        this.#close(room)
        removed++
      }
    }

    for (const [address, reservation] of this.#reservations) {
      if (now - reservation.createdAt > RESERVATION_TTL_MS) this.#reservations.delete(address)
    }

    return removed
  }

  #close(room: Room): void {
    for (const player of [room.creator, room.opponent]) {
      if (player) this.#playerRoom.delete(player)
    }
    this.#rooms.delete(room.id)
    this.#emit({ t: 'remove', roomId: room.id })
  }

  async #readMatch(matchId: Uint8Array) {
    try {
      return await this.chain.getMatch(matchId)
    } catch (err) {
      throw new LobbyError('chain_error', `Falha ao ler a blockchain: ${String(err)}`)
    }
  }

  /** Só para o servidor montar a resposta de `deposit.required`. */
  static timeoutSeconds(): number {
    return MATCH_TIMEOUT_SECONDS
  }

  static publicKeyIsValid(address: string): boolean {
    try {
      new PublicKey(address)
      return true
    } catch {
      return false
    }
  }
}
