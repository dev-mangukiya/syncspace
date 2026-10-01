'use client';

import { create } from 'zustand';
import { authAPI, User } from '@/app/lib/api';

interface AuthState {
  user: User | null;
  isLoading: boolean;
  isAuthenticated: boolean;

  setAuth: (user: User) => void;
  logout: () => Promise<void>;
  checkAuth: () => Promise<void>;
}

export const useAuthStore = create<AuthState>((set) => ({
  user: null,
  isLoading: true,
  isAuthenticated: false,

  setAuth: (user: User) => {
    // No localStorage — the JWT is in an httpOnly cookie (set by the server).
    // We only store the user object in Zustand memory.
    set({ user, isAuthenticated: true, isLoading: false });
  },

  logout: async () => {
    try {
      await authAPI.logout();
    } catch {
      // Server might be unreachable; clear client state anyway
    }
    set({ user: null, isAuthenticated: false, isLoading: false });
  },

  checkAuth: async () => {
    try {
      // The httpOnly cookie is sent automatically (withCredentials: true).
      // If the access token is expired, the API interceptor will try refresh.
      const response = await authAPI.me();
      set({
        user: response.data,
        isAuthenticated: true,
        isLoading: false,
      });
    } catch {
      set({ user: null, isAuthenticated: false, isLoading: false });
    }
  },
}));
