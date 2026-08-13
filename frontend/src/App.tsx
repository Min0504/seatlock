import { Link, NavLink, Outlet, Route, Routes, useNavigate } from 'react-router-dom'
import { useAuth } from './auth'
import CheckoutPage from './pages/CheckoutPage'
import LoginPage from './pages/LoginPage'
import MyReservationsPage from './pages/MyReservationsPage'
import PerformanceDetailPage from './pages/PerformanceDetailPage'
import PerformanceListPage from './pages/PerformanceListPage'
import SeatMapPage from './pages/SeatMapPage'

function Layout() {
  const { email, logout } = useAuth()
  const navigate = useNavigate()

  return (
    <div className="mx-auto min-h-screen max-w-5xl px-4">
      <header className="flex items-center justify-between border-b border-zinc-800 py-4">
        <Link to="/" className="text-lg font-bold tracking-tight">
          Seat<span className="text-indigo-400">Lock</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm">
          <NavLink
            to="/"
            className={({ isActive }) => (isActive ? 'text-indigo-300' : 'text-zinc-400 hover:text-zinc-200')}
          >
            공연
          </NavLink>
          <NavLink
            to="/me/reservations"
            className={({ isActive }) => (isActive ? 'text-indigo-300' : 'text-zinc-400 hover:text-zinc-200')}
          >
            내 예매
          </NavLink>
          {email ? (
            <button
              onClick={() => void logout().then(() => navigate('/'))}
              className="rounded-md border border-zinc-800 px-3 py-1.5 text-zinc-400 hover:text-zinc-200"
            >
              {email.split('@')[0]} · 로그아웃
            </button>
          ) : (
            <Link to="/login" className="rounded-md bg-indigo-600 px-3 py-1.5 font-medium text-white hover:bg-indigo-500">
              로그인
            </Link>
          )}
        </nav>
      </header>
      <main className="py-8">
        <Outlet />
      </main>
    </div>
  )
}

export default function App() {
  return (
    <Routes>
      <Route element={<Layout />}>
        <Route index element={<PerformanceListPage />} />
        <Route path="performances/:id" element={<PerformanceDetailPage />} />
        <Route path="shows/:showId/seats" element={<SeatMapPage />} />
        <Route path="checkout/:reservationId" element={<CheckoutPage />} />
        <Route path="me/reservations" element={<MyReservationsPage />} />
        <Route path="login" element={<LoginPage />} />
      </Route>
    </Routes>
  )
}
