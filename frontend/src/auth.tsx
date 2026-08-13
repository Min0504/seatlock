import { createContext, useCallback, useContext, useState, type ReactNode } from 'react'
import { api, clearSession, loadEmail, loadTokens, saveSession } from './api/client'

interface AuthState {
  email: string | null
  login: (email: string, password: string) => Promise<void>
  signup: (email: string, password: string) => Promise<void>
  logout: () => Promise<void>
}

const AuthContext = createContext<AuthState | null>(null)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [email, setEmail] = useState<string | null>(() =>
    loadTokens() ? loadEmail() : null,
  )

  const login = useCallback(async (email: string, password: string) => {
    const tokens = await api.login(email, password)
    saveSession(tokens, email)
    setEmail(email)
  }, [])

  const signup = useCallback(
    async (email: string, password: string) => {
      await api.signup(email, password)
      await login(email, password)
    },
    [login],
  )

  const logout = useCallback(async () => {
    const tokens = loadTokens()
    if (tokens) await api.logout(tokens.refreshToken).catch(() => {})
    clearSession()
    setEmail(null)
  }, [])

  return (
    <AuthContext.Provider value={{ email, login, signup, logout }}>
      {children}
    </AuthContext.Provider>
  )
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('AuthProvider missing')
  return ctx
}
