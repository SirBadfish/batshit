// Redis-based authentication service for Batshit (server-side only)
import { createClient } from 'redis';
import crypto from 'crypto';
import bcrypt from 'bcrypt';
import { sanitizeId } from '$lib/utils/idSanitizer';
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

export function resolveAuthRedisDatabase(url: string): number {
    const segment = new URL(url).pathname.replace(/^\//, '');
    if (!segment) return 0;
    if (!/^\d+$/.test(segment) || !Number.isSafeInteger(Number(segment))) {
        throw new Error('The authentication Redis URL must name a valid database number.');
    }
    return Number(segment);
}

// BL-1482: admission and all five existing account writes are one Redis operation.
// A page-load redirect is not authorization for the subsequent setup POST. No
// lock key is needed: the account namespaces themselves close first-run admission.
export const CREATE_INITIAL_ADMIN_SCRIPT = `
if redis.call('EXISTS', KEYS[4], KEYS[5]) > 0 then return 'EXISTS' end
for _, pattern in ipairs({'user:*', 'email:*', 'user_session:*'}) do
    local cursor = '0'
    repeat
        local batch = redis.call('SCAN', cursor, 'MATCH', pattern, 'COUNT', 100)
        for _, key in ipairs(batch[2]) do
            -- This exact legacy System Clip index is instance metadata, not
            -- an account. No other user:system:* key receives an exemption.
            if key ~= 'user:system:clips' then return 'EXISTS' end
        end
        cursor = batch[1]
    until cursor == '0'
end
for _, key in ipairs(KEYS) do
    if redis.call('EXISTS', key) > 0 then return 'EXISTS' end
end

-- Validate every JSON argument before the first write. Use the original JSON
-- bytes for JSON.SET; cjson re-encoding would change stored numeric precision.
local data = cjson.decode(ARGV[3])
local settings = cjson.decode(ARGV[4])
if type(data) ~= 'table' or type(settings) ~= 'table' or
    data.id ~= ARGV[1] or data.email ~= ARGV[2] or
    type(data.password) ~= 'string' or data.is_admin ~= true or
    settings.user_id ~= ARGV[1] then
    return 'INVALID'
end
local writes = {
    {'JSON.SET', KEYS[1], '$', ARGV[3], 'NX'},
    {'JSON.SET', KEYS[2], '$', ARGV[4], 'NX'},
    {'SET', KEYS[3], ARGV[1], 'NX'},
    {'SADD', KEYS[4], ARGV[1]},
    {'SET', KEYS[5], ARGV[1], 'NX'}
}
local created = {}
for index, command in ipairs(writes) do
    local answer = redis.pcall(unpack(command))
    local ok = index == 4 and answer == 1 or
        index ~= 4 and type(answer) == 'table' and answer.ok == 'OK'
    if not ok then
        -- Lua does not undo earlier commands on failure. Only these proven-new
        -- keys belong to this invocation; no pre-existing state can be erased.
        if #created > 0 then
            local removed = redis.pcall('DEL', unpack(created))
            if removed ~= #created then return 'PARTIAL' end
        end
        return 'WRITE_FAILED'
    end
    created[#created + 1] = KEYS[index]
end
return 'CREATED'
`;

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

export class AuthService {
    private redis: ReturnType<typeof createClient> | null = null;

    // Initialize Redis connection
    private async ensureRedis() {
        if (!this.redis) {
            const url = resolveAuthRedisUrl();
            this.redis = createClient({
                url,
                database: resolveAuthRedisDatabase(url)
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
    async createAdminUser(email: string, password: string, displayName: string): Promise<{ success: boolean; user?: User; error?: string; status?: number }> {
        if (typeof email !== 'string' || !email.trim() ||
            typeof password !== 'string' || password.length < 10 ||
            typeof displayName !== 'string' || !displayName.trim()) {
            return { success: false, status: 400, error: 'A name, email and password of at least 10 characters are required.' };
        }
        const userId = sanitizeId(displayName);
        if (!userId) {
            return { success: false, status: 400, error: 'The name must contain a letter or number.' };
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

        const redis = await this.ensureRedis();
        const result = await redis.eval(CREATE_INITIAL_ADMIN_SCRIPT, {
            keys: [`user:${userId}:data`, `user:${userId}:settings`, `email:${email}`, 'users:all', 'user:admin'],
            arguments: [userId, email, JSON.stringify(userData), JSON.stringify(userSettings)]
        });
        if (result === 'EXISTS') {
            return {
                success: false,
                status: 409,
                error: 'An admin account or saved account state already exists. Sign in or recover that account instead.'
            };
        }
        if (result !== 'CREATED') {
            throw new Error(result === 'WRITE_FAILED' || result === 'INVALID'
                ? 'Admin setup failed without creating an account. Check the app logs before retrying.'
                : 'Admin setup could not confirm account creation. Account state was kept; check the app logs before retrying.');
        }

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
