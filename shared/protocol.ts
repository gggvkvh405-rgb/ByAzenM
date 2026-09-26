export type Presence = 'online' | 'idle' | 'dnd' | 'offline' | 'playing';
export type Role = 'admin' | 'mod' | 'member';
export type ChannelType = 'text' | 'voice' | 'announcement';

export interface PublicUser {
  id: string;
  username: string;
  avatar: string;
  bio: string;
  status: Presence;
  customStatus: string;
  customEmoji: string;
  lastSeen: number;
  nitro?: boolean;
  activity?: { type: 'playing'; name: string } | null;
}

export interface ChatMessage {
  id: string;
  convoId: string;
  fromId: string;
  text: string;
  at: number;
  type: 'text' | 'file' | 'voice' | 'gif' | 'sticker' | 'poll' | 'system';
  meta?: Record<string, unknown> | null;
  edited?: boolean;
  deleted?: boolean;
  replyTo?: string | null;
  reactions?: Record<string, string[]>;
  pinned?: boolean;
  expiresAt?: number;
  e2e?: boolean;
}

export interface IceServer {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export interface Health {
  ok: boolean;
  version: string;
  storage: 'sqlite' | 'memory';
  multer: boolean;
  sfu: boolean;
}
