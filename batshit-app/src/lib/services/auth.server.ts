// Redis-based authentication service for Batshit (server-side only)
import { createClient } from 'redis';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { sanitizeId, suggestAlternatives } from '$lib/utils/idSanitizer';
import { normalizeGoonsSettings } from '$lib/goons/resolve';

// Session duration (24 hours in seconds)
const SESSION_TTL = 24 * 60 * 60;

// Bcrypt cost factor (rounds)
const BCRYPT_ROUNDS = 10;

export function resolveAuthRedisUrl(env: NodeJS.ProcessEnv = process.env): string {
    if (env.REDIS_URL && env.REDIS_URL.trim().length > 0) {
        return env.REDIS_URL.trim();
    }

    const host = env.REDIS_HOST && env.REDIS_HOST.trim().length > 0
        ? env.REDIS_HOST.trim()
        : 'localhost';
    const port = env.REDIS_PORT && env.REDIS_PORT.trim().length > 0
        ? env.REDIS_PORT.trim()
        : '6379';
    const db = env.REDIS_DB && env.REDIS_DB.trim().length > 0
        ? `/${env.REDIS_DB.trim().replace(/^\/+/, '')}`
        : '';

    return `redis://${host}:${port}${db}`;
}

export function resolveSessionCookieName(env: NodeJS.ProcessEnv = process.env): string {
    const explicit = env.BATSHIT_SESSION_COOKIE_NAME?.trim();
    if (explicit) return explicit;

    if (env.BATSHIT_CONTAINERIZED === '1') return 'batshit_session_docker';
    return 'batshit_session';
}

function parseBooleanEnv(value: string | undefined): boolean | null {
    if (!value) return null;
    const normalized = value.trim().toLowerCase();
    if (['1', 'true', 'yes', 'on'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off'].includes(normalized)) return false;
    return null;
}

export function resolveSessionCookieSecure(env: NodeJS.ProcessEnv = process.env): boolean {
    const explicit = parseBooleanEnv(env.BATSHIT_SESSION_COOKIE_SECURE);
    if (explicit !== null) return explicit;

    const publicOrigin =
        env.ORIGIN?.trim() ||
        env.PUBLIC_BASE_URL?.trim() ||
        env.BATSHIT_FRONTEND_URL?.trim() ||
        '';

    if (publicOrigin) {
        try {
            const parsed = new URL(publicOrigin);
            return parsed.protocol === 'https:';
        } catch {
            // Fall through to the environment default below.
        }
    }

    return env.NODE_ENV === 'production' && env.BATSHIT_CONTAINERIZED !== '1';
}

export interface User {
    id: string;
    email: string;
    is_admin: boolean;
}

export interface Session {
    token: string;
    user_id: string;
    email: string;
    created_at: string;
    expires_at: string;
}

class AuthService {
    private redis: ReturnType<typeof createClient> | null = null;

    // Initialize Redis connection
    private async ensureRedis() {
        if (!this.redis) {
            this.redis = createClient({
                url: resolveAuthRedisUrl()
            });
            
            this.redis.on('error', (err) => {
                console.error('Redis error in auth service:', err);
            });
            
            await this.redis.connect();
        }
        return this.redis;
    }

    // Hash password using bcrypt for security
    private async hashPassword(password: string): Promise<string> {
        return await bcrypt.hash(password, BCRYPT_ROUNDS);
    }

    // Generate secure session token
    private generateToken(): string {
        return crypto.randomBytes(32).toString('hex');
    }

    // Check if any users exist
    async hasUsers(): Promise<boolean> {
        const redis = await this.ensureRedis();
        const userCount = await redis.sCard('users:all');
        return userCount > 0;
    }

    // Check if user is admin
    async isAdmin(userId: string): Promise<boolean> {
        const redis = await this.ensureRedis();
        const adminUserId = await redis.get('user:admin');
        return adminUserId === userId;
    }

    // Create the first admin user
    async createAdminUser(email: string, password: string, displayName: string): Promise<{ success: boolean; user?: User; error?: string }> {
        const redis = await this.ensureRedis();

        // Generate slug-based user ID from display name
        const userId = sanitizeId(displayName);

        // CRITICAL: Check for collision BEFORE creating user
        const exists = await redis.exists(`user:${userId}:settings`);
        if (exists) {
            const suggestions = suggestAlternatives(userId, 3);
            return {
                success: false,
                error: `Username '${userId}' already exists. Try ${suggestions.map(s => `'${s}'`).join(', ')} or choose a different name.`
            };
        }

        const hashedPassword = await this.hashPassword(password);

        // Store user data as JSON object (indexed by slug ID)
        const userData = {
            id: userId,
            email,
            password: hashedPassword,
            display_name: displayName,
            is_admin: true,
            created_at: new Date().toISOString()
        };

        await redis.json.set(`user:${userId}:data`, '$', userData);

        // Create email→userId mapping for authentication lookup
        await redis.set(`email:${email}`, userId);

        // Mark as admin (use slug ID)
        await redis.set('user:admin', userId);

        // Add to users set (use slug ID)
        await redis.sAdd('users:all', userId);

        // Create user settings with display name using RedisJSON
        const userSettings = {
            id: `settings_${userId}`,
            user_id: userId,
            displayName: displayName,
            email: email,
            goons_settings: normalizeGoonsSettings(null),
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString()
        };

        await redis.json.set(`user:${userId}:settings`, '$', userSettings);

        return {
            success: true,
            user: {
                id: userId,
                email,
                is_admin: true
            }
        };
    }

    // Authenticate user
    async authenticate(email: string, password: string): Promise<User | null> {
        const redis = await this.ensureRedis();

        // Look up user ID from email mapping
        const userId = await redis.get(`email:${email}`);
        if (!userId) {
            return null;
        }

        // Get user data using RedisJSON (slug-based key)
        const userData = await redis.json.get(`user:${userId}:data`) as any;

        if (!userData || !userData.password) {
            return null;
        }

        if (!userData.password.startsWith('$2a$') && !userData.password.startsWith('$2b$')) {
            return null;
        }

        const passwordValid = await bcrypt.compare(password, userData.password);
        if (!passwordValid) {
            return null;
        }

        const isAdmin = await this.isAdmin(userId);

        return {
            id: userData.id,
            email: userData.email,
            is_admin: isAdmin
        };
    }

    // Create session
    async createSession(user: User, rememberMe = false): Promise<Session> {
        const redis = await this.ensureRedis();
        const token = this.generateToken();
        const now = new Date();
        const ttl = rememberMe ? SESSION_TTL * 30 : SESSION_TTL; // 30 days if remember me
        const expiresAt = new Date(now.getTime() + ttl * 1000);

        const session = {
            token,
            user_id: user.id,
            email: user.email,
            created_at: now.toISOString(),
            expires_at: expiresAt.toISOString()
        };

        // Store session using RedisJSON with TTL (using user_session prefix to avoid confusion with chat sessions)
        await redis.json.set(`user_session:${token}`, '$', session);
        await redis.expire(`user_session:${token}`, ttl);

        return session;
    }

    // Get session
    async getSession(token: string): Promise<Session | null> {
        const redis = await this.ensureRedis();
        const sessionData = await redis.json.get(`user_session:${token}`);

        if (!sessionData) {
            return null;
        }

        return sessionData as unknown as Session;
    }

    // Delete session (logout)
    async deleteSession(token: string): Promise<void> {
        const redis = await this.ensureRedis();
        await redis.del(`user_session:${token}`);
    }

    // Validate session and refresh TTL
    async validateSession(token: string): Promise<{ user: User; session: Session } | null> {
        const redis = await this.ensureRedis();
        const session = await this.getSession(token);

        if (!session) {
            return null;
        }

        // Check if expired
        if (new Date(session.expires_at) < new Date()) {
            await this.deleteSession(token);
            return null;
        }

        // Look up user ID from email mapping
        const userId = await redis.get(`email:${session.email}`);
        if (!userId) {
            return null;
        }

        // Get user data using RedisJSON (slug-based key)
        const userData = await redis.json.get(`user:${userId}:data`);
        if (!userData) {
            return null;
        }

        const isAdmin = await this.isAdmin(userId);
        const user: User = {
            id: (userData as any).id,
            email: (userData as any).email,
            is_admin: isAdmin
        };

        return { user, session };
    }

    async disconnect(): Promise<void> {
        if (!this.redis) return;

        const redis = this.redis;
        this.redis = null;
        if (redis.isOpen) {
            await redis.disconnect();
        }
    }
}

export const authService = new AuthService();
