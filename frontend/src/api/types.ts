// 백엔드 DTO 미러 — backend/src/main/java/com/seatlock/**/dto 와 1:1

export type SeatStatus = 'AVAILABLE' | 'HELD' | 'RESERVED'
export type ReservationStatus = 'PENDING' | 'CONFIRMED' | 'CANCELED'
export type PaymentStatus = 'PENDING' | 'APPROVED' | 'FAILED' | 'CANCELED'
export type PaymentMethod = 'CARD' | 'EASY_PAY'

export interface ApiErrorBody {
  code: string
  message: string
  details?: Record<string, unknown>
}

export interface TokenPair {
  accessToken: string
  refreshToken: string
}

export interface PerformanceListItem {
  id: number
  title: string
  posterUrl: string | null
  venueName: string
}

export interface PerformanceListResponse {
  items: PerformanceListItem[]
  nextCursor: string | null
}

export interface ShowSummary {
  id: number
  startsAt: string
  ticketOpenAt: string
}

export interface PerformanceDetail {
  id: number
  title: string
  description: string | null
  posterUrl: string | null
  venue: { id: number; name: string; address: string }
  shows: ShowSummary[]
}

export interface SeatMapEntry {
  id: number
  section: string
  rowNo: string
  seatNo: number
  price: number
  status: SeatStatus
}

export interface SeatMapResponse {
  showId: number
  seats: SeatMapEntry[]
}

export interface HeldSeat {
  id: number
  section: string
  rowNo: string
  seatNo: number
  price: number
}

export interface HoldResponse {
  holdGroupId: string
  expiresAt: string
  seats: HeldSeat[]
}

export interface CreatedReservation {
  id: number
  status: ReservationStatus
  totalPrice: number
  seatCount: number
  payUntil: string
}

export interface PaymentView {
  paymentId: number
  reservationId: number
  status: PaymentStatus
  amount: number
  method: string
  pgTxId: string | null
}

export interface ReservationSummary {
  id: number
  status: ReservationStatus
  totalPrice: number
  createdAt: string
  show: { id: number; startsAt: string; performanceTitle: string }
  seats: { section: string; rowNo: string; seatNo: number; price: number }[]
}

export interface MyReservationsResponse {
  items: ReservationSummary[]
  nextCursor: string | null
}

export interface CancelResult {
  id: number
  status: ReservationStatus
  releasedSeats: number
}
