import axios from 'axios';

const API_BASE = '';

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'Content-Type': 'application/json',
  },
  // Send httpOnly cookies with every request (access token lives in a cookie)
  withCredentials: true,
});

// Attach CSRF token to every state-changing request.
// The CSRF token is stored in a non-httpOnly cookie (syncspace_csrf) by the server,
// and sent back in the X-CSRF-Token header (double-submit cookie pattern).
api.interceptors.request.use((config) => {
  if (typeof window !== 'undefined') {
    // Read CSRF token from cookie
    const csrfToken = getCookie('syncspace_csrf');
    if (csrfToken && config.method && ['post', 'put', 'delete', 'patch'].includes(config.method)) {
      config.headers['X-CSRF-Token'] = csrfToken;
    }
  }
  return config;
});

// Handle 401s by attempting a token refresh, then redirecting if that fails too
let isRefreshing = false;
let refreshSubscribers: ((csrfToken: string) => void)[] = [];

function onRefreshed(csrfToken: string) {
  refreshSubscribers.forEach(cb => cb(csrfToken));
  refreshSubscribers = [];
}

api.interceptors.response.use(
  (response) => response,
  async (error) => {
    const originalRequest = error.config;
    
    if (error.response?.status === 401 && !originalRequest._retry && typeof window !== 'undefined') {
      // Don't retry refresh or auth endpoints
      if (originalRequest.url?.includes('/api/auth/')) {
        return Promise.reject(error);
      }

      if (isRefreshing) {
        // Queue this request until refresh completes
        return new Promise((resolve) => {
          refreshSubscribers.push((csrfToken: string) => {
            originalRequest.headers['X-CSRF-Token'] = csrfToken;
            resolve(api(originalRequest));
          });
        });
      }

      originalRequest._retry = true;
      isRefreshing = true;

      try {
        // Attempt silent refresh
        const res = await axios.post('/api/auth/refresh', {}, { withCredentials: true });
        const newCsrf = res.data.csrf_token;
        isRefreshing = false;
        onRefreshed(newCsrf);
        originalRequest.headers['X-CSRF-Token'] = newCsrf;
        return api(originalRequest);
      } catch {
        isRefreshing = false;
        refreshSubscribers = [];
        // Refresh failed — redirect to login
        if (!window.location.pathname.startsWith('/auth')) {
          window.location.href = '/auth/login';
        }
        return Promise.reject(error);
      }
    }
    return Promise.reject(error);
  }
);

// Helper to read a cookie by name
function getCookie(name: string): string | null {
  if (typeof document === 'undefined') return null;
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  return match ? decodeURIComponent(match[2]) : null;
}

export interface User {
  id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string;
  created_at: string;
  updated_at: string;
}

export interface Workspace {
  id: string;
  name: string;
  slug: string;
  short_id: string;
  description: string;
  owner_id: string;
  template: string;
  language: string;
  is_public: boolean;
  created_at: string;
  updated_at: string;
  role?: string;
}

export interface FileEntry {
  id: string;
  workspace_id: string;
  path: string;
  content: string;
  language: string;
  created_at: string;
  updated_at: string;
}

export interface AuthResponse {
  user: User;
  csrf_token: string;
  // Note: no 'token' field — JWT is in httpOnly cookie
}

export interface Member {
  member_id: string;
  user_id: string;
  username: string;
  email: string;
  display_name: string;
  avatar_url: string;
  role: string;
  color_slot: number;
}

// Auth API
export const authAPI = {
  signup: (username: string, email: string, password: string) =>
    api.post<AuthResponse>('/api/auth/signup', { username, email, password }),

  login: (identifier: string, password: string) =>
    api.post<AuthResponse>('/api/auth/login', { identifier, password }),

  me: () => api.get<User>('/api/auth/me'),

  logout: () => api.post('/api/auth/logout'),

  refresh: () => api.post<AuthResponse>('/api/auth/refresh'),
};

// Workspace API
export const workspaceAPI = {
  list: () => api.get<Workspace[]>('/api/workspaces'),

  get: (slug: string) => api.get<Workspace>(`/api/workspaces/${slug}`),

  create: (data: { name: string; description?: string; template?: string; language?: string }) =>
    api.post<Workspace>('/api/workspaces', data),

  delete: (slug: string) => api.delete(`/api/workspaces/${slug}`),

  listFiles: (slug: string) => api.get<FileEntry[]>(`/api/workspaces/${slug}/files`),

  getFile: (slug: string, path: string) =>
    api.get<FileEntry>(`/api/workspaces/${slug}/file?path=${encodeURIComponent(path)}`),

  createFile: (slug: string, path: string, content: string = '') =>
    api.post<FileEntry>(`/api/workspaces/${slug}/file`, { path, content }),

  updateFile: (slug: string, path: string, content: string) =>
    api.put<FileEntry>(`/api/workspaces/${slug}/file`, { path, content }),

  deleteFile: (slug: string, path: string) =>
    api.delete(`/api/workspaces/${slug}/file?path=${encodeURIComponent(path)}`),

  renameFile: (slug: string, oldPath: string, newPath: string) =>
    api.post(`/api/workspaces/${slug}/file/rename`, { old_path: oldPath, new_path: newPath }),

  // Member management
  listMembers: (slug: string) =>
    api.get<Member[]>(`/api/workspaces/${slug}/members`),

  inviteMember: (slug: string, identifier: string, role: string = 'editor') =>
    api.post<Member[]>(`/api/workspaces/${slug}/members`, { identifier, role }),

  updateMemberRole: (slug: string, userId: string, role: string) =>
    api.put(`/api/workspaces/${slug}/members/${userId}`, { role }),

  removeMember: (slug: string, userId: string) =>
    api.delete(`/api/workspaces/${slug}/members/${userId}`),

  // Workspace chat (persisted in Postgres, last 200 messages)
  listMessages: (slug: string) =>
    api.get<WorkspaceChatMessage[]>(`/api/workspaces/${slug}/messages`),

  sendMessage: (slug: string, content: string) =>
    api.post<WorkspaceChatMessage>(`/api/workspaces/${slug}/messages`, { content }),
};

export interface WorkspaceChatMessage {
  id: string;
  workspace_id: string;
  user_id: string;
  username: string;
  avatar_url: string;
  color_slot: number;
  content: string;
  created_at: string;
}

export default api;
