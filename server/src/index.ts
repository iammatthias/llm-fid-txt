import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamText } from "hono/streaming";
import { cache } from "hono/cache";
import type { FarcasterResponse, UserNameProof, FarcasterUser, FarcasterCast, FarcasterQueryParams } from "shared";

// Use the correct Pinata hub URL for Snapchain API
const SNAPCHAIN_BASE_URL = process.env.SNAPCHAIN_BASE_URL || "https://hub.pinata.cloud";
const API_TIMEOUT = 10000; // 10 seconds
// Farcaster epoch starts on January 1, 2021
const FARCASTER_EPOCH = new Date("2021-01-01T00:00:00.000Z").getTime();

// Cache configuration
const CACHE_CONFIG = {
  USER_DATA_TTL: 60 * 1000, // 1 minute
  CASTS_TTL: 60 * 1000, // 1 minute
  REACTIONS_TTL: 60 * 1000, // 1 minute
  USERNAME_RESOLUTION_TTL: 5 * 60 * 1000, // 5 minutes
  DEFAULT_TTL: 60 * 1000, // 1 minute default
  STALE_WHILE_REVALIDATE: 5 * 60 * 1000, // 5 minutes
  MAX_CACHE_ITEMS: 1000,
  MAX_CACHE_SIZE: 5 * 1024 * 1024, // 5MB
};

// Rate limiting constants
const MAX_RETRIES = 3;
const INITIAL_RETRY_DELAY = 1000; // 1 second
const RATE_LIMIT_CACHE_TTL = 300; // 5 minutes
const REQUEST_QUEUE_DELAY = 100; // 100ms between requests
const MAX_CONCURRENT_REQUESTS = 3; // Maximum number of concurrent requests

// Circuit breaker configuration
const CIRCUIT_BREAKER_CONFIG = {
  failureThreshold: 5,
  resetTimeout: 30000, // 30 seconds
  halfOpenTimeout: 10000, // 10 seconds
};

// Update batch processing configuration
const BATCH_CONFIG = {
  MAX_BATCH_SIZE: 50,
  BATCH_TIMEOUT: 1000, // 1 second
  PARALLEL_BATCHES: 3,
  REACTIONS_BATCH_SIZE: 20, // Smaller batch size for reactions
  PARENTS_BATCH_SIZE: 10, // Smaller batch size for parent casts
};

interface SnapchainMessage {
  hash: string;
  hashScheme: string;
  signature: string;
  signatureScheme: string;
  signer: string;
  data: {
    type: string;
    fid: number;
    timestamp: number;
    network: string;
    username: string;
    display_name?: string;
    pfp_url?: string;
    following?: boolean;
    followed_by?: boolean;
    userDataBody?: {
      type: string | number;
      value: string;
    };
    castAddBody?: {
      text: string;
      parentCastId?: {
        fid: number;
        hash: string;
      };
      attachments?: Array<{
        type: string;
        url: string;
      }>;
      embeds?: Array<{
        type: string;
        url: string;
      }>;
      embedsDeprecated?: Array<{
        type: string;
        url: string;
      }>;
    };
    reactionBody?: {
      type: string | number;
      targetCastId?: {
        fid: number;
        hash: string;
      };
      targetUrl?: string;
    };
  };
}

interface SnapchainResponse {
  messages: SnapchainMessage[];
  nextPageToken?: string;
}

// Add this interface after other interfaces
interface RateLimitCache {
  [key: string]: {
    timestamp: number;
    data: { likes: number; recasts: number };
  };
}

// Add this cache object after other constants
const rateLimitCache: RateLimitCache = {};

const app = new Hono();

// Enable CORS
app.use(
  "/*",
  cors({
    origin: ["https://llm-fid.fun", "http://localhost:3000"],
    allowMethods: ["GET"],
    allowHeaders: ["Content-Type"],
    exposeHeaders: ["Content-Type"],
    maxAge: 86400,
  })
);

// Enhanced RequestQueue with circuit breaker and adaptive rate limiting
class RequestQueue {
  private queue: Array<() => Promise<void>> = [];
  private running = 0;
  private failures: Map<string, number> = new Map();
  private lastFailureTime: Map<string, number> = new Map();
  private responseTimes: number[] = [];
  private currentDelay = REQUEST_QUEUE_DELAY;

  async add<T>(fn: () => Promise<T>, endpoint: string): Promise<T> {
    return new Promise((resolve, reject) => {
      this.queue.push(async () => {
        try {
          // Check circuit breaker
          if (this.isCircuitOpen(endpoint)) {
            throw new Error(`Circuit breaker open for ${endpoint}`);
          }

          const startTime = Date.now();
          const result = await fn();
          const responseTime = Date.now() - startTime;

          // Update response time tracking
          this.responseTimes.push(responseTime);
          if (this.responseTimes.length > 10) {
            this.responseTimes.shift();
          }

          // Adjust delay based on response times
          this.adjustDelay();

          // Reset failure count on success
          this.failures.set(endpoint, 0);
          resolve(result);
        } catch (error) {
          // Increment failure count
          const failures = (this.failures.get(endpoint) || 0) + 1;
          this.failures.set(endpoint, failures);
          this.lastFailureTime.set(endpoint, Date.now());

          reject(error);
        } finally {
          this.running--;
          this.processQueue();
        }
      });
      this.processQueue();
    });
  }

  private isCircuitOpen(endpoint: string): boolean {
    const failures = this.failures.get(endpoint) || 0;
    const lastFailure = this.lastFailureTime.get(endpoint) || 0;
    const now = Date.now();

    if (failures >= CIRCUIT_BREAKER_CONFIG.failureThreshold) {
      if (now - lastFailure < CIRCUIT_BREAKER_CONFIG.resetTimeout) {
        return true;
      }
      // Try half-open state
      if (now - lastFailure < CIRCUIT_BREAKER_CONFIG.resetTimeout + CIRCUIT_BREAKER_CONFIG.halfOpenTimeout) {
        return false;
      }
      // Reset after full timeout
      this.failures.set(endpoint, 0);
    }
    return false;
  }

  private adjustDelay() {
    if (this.responseTimes.length < 2) return;

    const avgResponseTime = this.responseTimes.reduce((a, b) => a + b) / this.responseTimes.length;
    const variance =
      this.responseTimes.reduce((a, b) => a + Math.pow(b - avgResponseTime, 2), 0) / this.responseTimes.length;

    // Adjust delay based on response time stability
    if (variance > 1000) {
      // High variance
      this.currentDelay = Math.min(this.currentDelay * 1.2, 500); // Increase delay, max 500ms
    } else if (variance < 100) {
      // Low variance
      this.currentDelay = Math.max(this.currentDelay * 0.8, 50); // Decrease delay, min 50ms
    }
  }

  private async processQueue() {
    if (this.running >= MAX_CONCURRENT_REQUESTS || this.queue.length === 0) {
      return;
    }

    this.running++;
    const next = this.queue.shift();
    if (next) {
      await sleep(this.currentDelay);
      await next();
    }
  }
}

const requestQueue = new RequestQueue();

// Helper function to fetch with retry and rate limiting
async function fetchWithRetry(url: string, options: RequestInit = {}, retryCount = 0): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT);

  try {
    const headers = {
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://llm-fid.fun",
      Referer: "https://llm-fid.fun/",
      ...options.headers,
    };

    const response = await fetch(url, {
      ...options,
      headers,
      signal: controller.signal,
      cf: {
        cacheTtl: 300,
        cacheEverything: true,
        resolveOverride: "hub.pinata.cloud",
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      if (response.status === 429 && retryCount < MAX_RETRIES) {
        const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
        console.log(`Rate limited, retrying in ${delay}ms...`);
        await sleep(delay);
        return fetchWithRetry(url, options, retryCount + 1);
      }
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${API_TIMEOUT}ms`);
    }
    if (error instanceof Error && error.message.includes("429") && retryCount < MAX_RETRIES) {
      const delay = INITIAL_RETRY_DELAY * Math.pow(2, retryCount);
      console.log(`Rate limited, retrying in ${delay}ms...`);
      await sleep(delay);
      return fetchWithRetry(url, options, retryCount + 1);
    }
    throw error;
  }
}

// Modified fetchWithTimeout to use the request queue
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  return requestQueue.add(() => fetchWithRetry(url, options), url);
}

// Helper function to resolve FID from username
async function resolveFid(username: string): Promise<number> {
  if (!username) {
    throw new Error("Username is required");
  }

  // Normalize username to lowercase
  const normalizedUsername = username.toLowerCase();
  const cacheKey = `username:${normalizedUsername}`;

  try {
    // Try to get from cache first
    const cached = await cacheManager.get<{ fid: number }>(cacheKey, CACHE_CONFIG.USERNAME_RESOLUTION_TTL);
    if (cached && !cached.stale) {
      return cached.data.fid;
    }

    const response = await fetchWithTimeout(
      `${SNAPCHAIN_BASE_URL}/v1/userNameProofByName?name=${encodeURIComponent(normalizedUsername)}`
    );

    if (!response?.ok) {
      // If the username proof fails, try to get the user data directly
      const userResponse = await fetchWithTimeout(
        `${SNAPCHAIN_BASE_URL}/v1/userDataByUsername?username=${encodeURIComponent(normalizedUsername)}`
      );

      if (!userResponse?.ok) {
        throw new Error(`Failed to resolve username: ${response.status} ${response.statusText}`);
      }

      const userData = (await userResponse.json()) as { fid: number };
      if (!userData.fid || userData.fid <= 0) {
        throw new Error(`Invalid FID returned for username: ${username}`);
      }

      // Cache the result
      await cacheManager.set(cacheKey, userData, CACHE_CONFIG.USERNAME_RESOLUTION_TTL);
      return userData.fid;
    }

    const data = (await response.json()) as UserNameProof;
    if (!data.fid || data.fid <= 0) {
      throw new Error(`Invalid FID returned for username: ${username}`);
    }

    // Cache the result
    await cacheManager.set(cacheKey, { fid: data.fid }, CACHE_CONFIG.USERNAME_RESOLUTION_TTL);
    return data.fid;
  } catch (error) {
    throw error;
  }
}

// Helper function to sleep
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Helper function to get cache key
function getCacheKey(targetFid: number, castHash: string, reactionType: string): string {
  return `${targetFid}-${castHash}-${reactionType}`;
}

// Helper function to check cache
function getFromCache(
  targetFid: number,
  castHash: string,
  reactionType: string
): { likes: number; recasts: number } | null {
  const key = getCacheKey(targetFid, castHash, reactionType);
  const cached = rateLimitCache[key];
  if (cached && Date.now() - cached.timestamp < RATE_LIMIT_CACHE_TTL * 1000) {
    return cached.data;
  }
  return null;
}

// Helper function to set cache
function setCache(
  targetFid: number,
  castHash: string,
  reactionType: string,
  data: { likes: number; recasts: number }
): void {
  const key = getCacheKey(targetFid, castHash, reactionType);
  rateLimitCache[key] = {
    timestamp: Date.now(),
    data,
  };
}

// Enhanced fetch with caching and batching
async function fetchWithCache<T>(
  url: string,
  options: RequestInit = {},
  ttl: number = CACHE_CONFIG.DEFAULT_TTL
): Promise<T> {
  const cacheKey = url;

  // Try to get from cache first
  const cached = await cacheManager.get<T>(cacheKey, ttl);
  if (cached) {
    if (!cached.stale) {
      return cached.data;
    }
    // If stale, try to revalidate in background
    void fetchWithTimeout(url, options)
      .then(async (response) => {
        if (response?.ok) {
          const data = (await response.json()) as T;
          await cacheManager.set(cacheKey, data, ttl);
        }
      })
      .catch(() => {
        // Ignore revalidation errors
      });
    return cached.data;
  }

  // If not in cache, fetch fresh data
  const response = await fetchWithTimeout(url, options);
  if (!response?.ok) {
    throw new Error(`Failed to fetch: ${response?.status} ${response?.statusText}`);
  }

  const data = (await response.json()) as T;
  await cacheManager.set(cacheKey, data, ttl);
  return data;
}

// Enhanced fetchCastReactions with batching
async function fetchCastReactions(castHash: string, targetFid: number): Promise<{ likes: number; recasts: number }> {
  const defaultReactions = { likes: 0, recasts: 0 };

  try {
    const cacheKey = `reactions:${targetFid}:${castHash}`;

    // Try to get from cache first
    const cached = await cacheManager.get<{ likes: number; recasts: number }>(cacheKey, CACHE_CONFIG.REACTIONS_TTL);
    if (cached?.data && !cached.stale) {
      return cached.data;
    }

    // Use batch processor
    return await reactionsBatchProcessor.add(
      `${targetFid}:${castHash}`,
      async (): Promise<{ likes: number; recasts: number }> => {
        const [likesResponse, recastsResponse] = await Promise.all([
          fetchWithTimeout(
            `${SNAPCHAIN_BASE_URL}/v1/reactionsByCast?target_fid=${targetFid}&target_hash=${castHash}&reaction_type=Like`
          ),
          fetchWithTimeout(
            `${SNAPCHAIN_BASE_URL}/v1/reactionsByCast?target_fid=${targetFid}&target_hash=${castHash}&reaction_type=Recast`
          ),
        ]);

        if (!likesResponse?.ok || !recastsResponse?.ok) {
          return defaultReactions;
        }

        const likesData = (await likesResponse.json()) as SnapchainResponse;
        const recastsData = (await recastsResponse.json()) as SnapchainResponse;

        const reactions = {
          likes: likesData?.messages?.length || 0,
          recasts: recastsData?.messages?.length || 0,
        };

        // Cache the results
        await cacheManager.set(cacheKey, reactions, CACHE_CONFIG.REACTIONS_TTL);
        return reactions;
      }
    );
  } catch (error) {
    console.error(`Error fetching reactions:`, error);
    return defaultReactions;
  }
}

// Enhanced fetchUserData with batching
async function fetchUserData(fidOrUsername: number | string, params: FarcasterQueryParams): Promise<FarcasterResponse> {
  let fid: number;

  if (typeof fidOrUsername === "number") {
    if (fidOrUsername <= 0) {
      throw new Error("Invalid FID provided");
    }
    fid = fidOrUsername;
  } else {
    try {
      const sanitizedUsername = (fidOrUsername.startsWith("@") ? fidOrUsername.slice(1) : fidOrUsername).toLowerCase();
      const cacheKey = `username:${sanitizedUsername}`;

      // Try to get from cache first
      const cached = await cacheManager.get<{ fid: number }>(cacheKey, CACHE_CONFIG.USERNAME_RESOLUTION_TTL);
      if (cached && !cached.stale) {
        fid = cached.data.fid;
      } else {
        fid = await resolveFid(sanitizedUsername);
        await cacheManager.set(cacheKey, { fid }, CACHE_CONFIG.USERNAME_RESOLUTION_TTL);
      }
    } catch (error) {
      throw new Error(`Failed to resolve username: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  // Use batch processor for user data
  const user = await userDataBatchProcessor.add(fid.toString(), async (): Promise<FarcasterUser> => {
    const response = await fetchWithTimeout(`${SNAPCHAIN_BASE_URL}/v1/userDataByFid?fid=${fid}`);
    if (!response?.ok) {
      throw new Error(`Failed to fetch user data: ${response?.status} ${response?.statusText}`);
    }
    const data = (await response.json()) as SnapchainResponse;
    return processUserData(data);
  });

  // Fetch casts with pagination
  const casts = await fetchCasts(fid, params);

  return { user, casts };
}

// Enhanced fetchCasts with optimized batching
async function fetchCasts(fid: number, params: FarcasterQueryParams): Promise<FarcasterCast[]> {
  const reverse = params.sortOrder === "oldest" ? "false" : "true";
  const targetLimit = params.limit ? Number(params.limit) : undefined;
  const includeReplies = params.includeReplies === true;
  const includeReactions = params.includeReactions === true;
  const includeParents = params.includeParents === true;
  const pageSize = includeReplies
    ? (targetLimit ? Math.min(100, targetLimit) : 100).toString()
    : (targetLimit ? Math.min(100, Math.max(targetLimit * 2, 20)) : 100).toString();

  let pageToken: string | undefined;
  const casts: FarcasterCast[] = [];
  const parentCastIds: Set<string> = new Set();

  do {
    const castsUrl = new URL(`${SNAPCHAIN_BASE_URL}/v1/castsByFid`);
    castsUrl.searchParams.set("fid", fid.toString());
    castsUrl.searchParams.set("pageSize", pageSize);
    castsUrl.searchParams.set("reverse", reverse);
    if (pageToken) {
      castsUrl.searchParams.set("pageToken", pageToken);
    }

    const response = await fetchWithTimeout(castsUrl.toString());
    if (!response?.ok) {
      throw new Error(`Failed to fetch casts: ${response?.status} ${response?.statusText}`);
    }

    const data = (await response.json()) as SnapchainResponse;

    // Process casts in parallel
    const processedCasts = await Promise.all(
      data.messages
        .filter((message) => message.data?.castAddBody)
        .map(async (message) => {
          const cast = processCast(message, fid);
          if (!includeReplies && cast.parentHash) {
            return null;
          }

          // Collect parent cast IDs if needed
          if (includeParents && cast.parentHash) {
            parentCastIds.add(cast.parentHash);
          }

          // Fetch reactions if needed and not fetching all casts
          if (includeReactions && !params.all) {
            const reactions = await fetchCastReactions(cast.hash, cast.author.fid);
            return { ...cast, reactions };
          }

          return cast;
        })
    );

    casts.push(...processedCasts.filter((cast): cast is FarcasterCast => cast !== null));

    pageToken = data.nextPageToken;
    if ((targetLimit && casts.length >= targetLimit) || !pageToken) break;
  } while (pageToken);

  // Fetch parent casts in batches if needed
  if (includeParents && parentCastIds.size > 0) {
    const parentCasts = await fetchParentCasts(Array.from(parentCastIds));
    // Merge parent casts with their replies
    casts.forEach((cast) => {
      if (cast.parentHash && parentCasts[cast.parentHash]) {
        cast.parentCast = parentCasts[cast.parentHash];
      }
    });
  }

  return casts;
}

// New function to fetch parent casts in batches
async function fetchParentCasts(castHashes: string[]): Promise<Record<string, FarcasterCast>> {
  const parentCasts: Record<string, FarcasterCast> = {};
  const batches = chunk(castHashes, BATCH_CONFIG.PARENTS_BATCH_SIZE);

  for (const batch of batches) {
    const batchPromises = batch.map(async (hash) => {
      try {
        const response = await fetchWithTimeout(`${SNAPCHAIN_BASE_URL}/v1/castById?hash=${hash}`);
        if (!response?.ok) return null;

        const data = (await response.json()) as SnapchainResponse;
        if (!data.messages?.[0]?.data?.castAddBody) return null;

        const cast = processCast(data.messages[0], data.messages[0].data.fid);
        return [hash, cast] as const;
      } catch (error) {
        console.error(`Error fetching parent cast ${hash}:`, error);
        return null;
      }
    });

    const results = await Promise.all(batchPromises);
    results.forEach((result) => {
      if (result) {
        const [hash, cast] = result;
        parentCasts[hash] = cast;
      }
    });

    // Add delay between batches to prevent rate limiting
    await sleep(100);
  }

  return parentCasts;
}

// Helper function to chunk array into smaller arrays
function chunk<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

// Helper function to process a cast
function processCast(message: SnapchainMessage, fid: number): FarcasterCast {
  const timestamp = message.data?.timestamp;
  const text = message.data?.castAddBody?.text || "";
  const attachments = message.data?.castAddBody?.attachments || [];
  const embeds = message.data?.castAddBody?.embeds || [];
  const embedsDeprecated = message.data?.castAddBody?.embedsDeprecated || [];
  const parentCastId = message.data?.castAddBody?.parentCastId;

  return {
    hash: message.hash || "",
    threadHash: parentCastId?.hash || "",
    parentHash: parentCastId?.hash,
    author: {
      fid,
      username: "", // Will be filled in by user data
    },
    text,
    timestamp:
      typeof timestamp === "number"
        ? new Date(FARCASTER_EPOCH + timestamp * 1000).toISOString()
        : new Date(0).toISOString(),
    attachments,
    embeds: [...embeds, ...embedsDeprecated],
    reactions: {
      likes: 0,
      recasts: 0,
    },
  };
}

function formatTextOutput(data: FarcasterResponse): string {
  const { user, casts } = data;

  let output = `Farcaster User Profile\n`;
  output += `===================\n\n`;
  output += `Username: ${user.username}\n`;
  output += `Display Name: ${user.displayName || "N/A"}\n`;
  output += `FID: ${user.fid}\n`;
  if (user.bio) output += `Bio: ${user.bio}\n`;
  if (user.pfp) output += `Profile Picture: ${user.pfp}\n`;
  if (user.url) output += `URL: ${user.url}\n`;
  if (user.location) output += `Location: ${user.location}\n`;
  if (user.twitter) output += `Twitter: @${user.twitter}\n`;
  if (user.github) output += `GitHub: ${user.github}\n`;
  output += `\nPosts\n`;
  output += `=====\n\n`;

  if (casts.length === 0) {
    output += "No posts found.\n";
  } else {
    casts.forEach((cast, index) => {
      output += `[${index + 1}] ${cast.timestamp}\n`;

      // If this is a reply, just indicate it's a reply
      if (cast.parentHash) {
        output += `\n[Reply]\n`;
      }

      output += `${cast.text}\n`;

      // Add reactions
      output += `\nReactions:\n`;
      output += `- Likes: ${cast.reactions.likes}\n`;
      output += `- Recasts: ${cast.reactions.recasts}\n`;

      if (cast.attachments?.length) {
        output += `\nAttachments:\n`;
        cast.attachments.forEach((attachment) => {
          output += `- ${attachment.type}: ${attachment.url}\n`;
        });
      }

      // Handle embeds more robustly
      const allEmbeds = [...(cast.embeds || []), ...(cast.embedsDeprecated || [])].filter(
        (embed) => embed && embed.url
      );

      if (allEmbeds.length > 0) {
        output += `\nEmbeds:\n`;
        allEmbeds.forEach((embed) => {
          output += `- ${embed.url}\n`;
        });
      }

      output += `\n---\n\n`;
    });
  }

  return output;
}

// Helper function to log (only in development)
const log = (...args: any[]) => {
  if (process.env.NODE_ENV !== "production") {
    console.log(...args);
  }
};

// Helper function to log errors (always log errors)
const logError = (...args: any[]) => {
  console.error(...args);
};

// Main API endpoint
app.get("/", async (c) => {
  try {
    const query = c.req.query();
    log("Received query params:", query);

    // If no query parameters, this is a client request
    if (Object.keys(query).length === 0) {
      return c.redirect("https://llm-fid.fun");
    }

    const typedQuery = query as FarcasterQueryParams;

    // Validate required parameters
    if (!typedQuery.fid && !typedQuery.username) {
      return c.text("Either fid or username is required", 400);
    }

    // Validate optional parameters
    if (typedQuery.limit && (isNaN(Number(typedQuery.limit)) || Number(typedQuery.limit) <= 0)) {
      return c.text("Invalid limit parameter", 400);
    }

    if (typedQuery.sortOrder && !["newest", "oldest"].includes(typedQuery.sortOrder)) {
      return c.text("Invalid sortOrder parameter", 400);
    }

    // Convert all parameter to boolean if it exists
    if (typedQuery.all !== undefined) {
      typedQuery.all = String(typedQuery.all).toLowerCase() === "true";
    }

    // Convert includeReplies parameter to boolean if it exists
    if (typedQuery.includeReplies !== undefined) {
      typedQuery.includeReplies = String(typedQuery.includeReplies).toLowerCase() === "true";
    }

    // Convert includeReactions parameter to boolean if it exists
    if (typedQuery.includeReactions !== undefined) {
      typedQuery.includeReactions = String(typedQuery.includeReactions).toLowerCase() === "true";
    }

    // Convert includeParents parameter to boolean if it exists
    if (typedQuery.includeParents !== undefined) {
      typedQuery.includeParents = String(typedQuery.includeParents).toLowerCase() === "true";
    }

    // Disable reactions and parents for all=true
    if (typedQuery.all === true) {
      typedQuery.includeReactions = false;
      typedQuery.includeParents = false;
    }

    // Convert fid to number if it exists
    if (typedQuery.fid) {
      typedQuery.fid = Number(typedQuery.fid);
    }

    // Remove limit parameter if all is true
    if (typedQuery.all === true) {
      delete typedQuery.limit;
    }

    // Remove @ symbol from username if present and normalize to lowercase
    if (typedQuery.username) {
      typedQuery.username = (
        typedQuery.username.startsWith("@") ? typedQuery.username.slice(1) : typedQuery.username
      ).toLowerCase();
    }

    // Set headers for streaming
    c.header("Content-Type", "text/plain");
    c.header("Content-Encoding", "Identity");
    c.header("Transfer-Encoding", "chunked");
    c.header("X-Content-Type-Options", "nosniff");

    // Create an AbortController for the stream
    const controller = new AbortController();
    const signal = controller.signal;

    // Listen for connection close
    c.req.raw.signal.addEventListener("abort", () => {
      controller.abort();
    });

    return streamText(c, async (stream) => {
      try {
        // Check if the connection is still alive before proceeding
        if (signal.aborted) {
          return;
        }

        let fid: number;
        if (typeof typedQuery.fid === "number") {
          if (typedQuery.fid <= 0) {
            await stream.writeln("Error: Invalid FID provided");
            return;
          }
          fid = typedQuery.fid;
        } else {
          try {
            const sanitizedUsername = typedQuery.username!.toLowerCase();
            await stream.writeln(`Resolving FID for username: ${sanitizedUsername}`);
            fid = await resolveFid(sanitizedUsername);
            await stream.writeln(`Resolved FID: ${fid}`);
          } catch (error) {
            await stream.writeln(
              `Error: Failed to resolve username: ${error instanceof Error ? error.message : "Unknown error"}`
            );
            return;
          }
        }

        // Check connection state before proceeding
        if (signal.aborted) {
          return;
        }

        // Fetch user data first
        const userResponse = await fetchWithTimeout(`${SNAPCHAIN_BASE_URL}/v1/userDataByFid?fid=${fid}`);
        if (!userResponse.ok) {
          const errorText = await userResponse.text();
          await stream.writeln(
            `Error: Failed to fetch user data: ${userResponse.status} ${userResponse.statusText}${
              errorText ? ` - ${errorText}` : ""
            }`
          );
          return;
        }

        // Check connection state before proceeding
        if (signal.aborted) {
          return;
        }

        const userData = (await userResponse.json()) as SnapchainResponse;
        if (!Array.isArray(userData.messages)) {
          await stream.writeln("Error: Invalid user data response format: messages array missing");
          return;
        }

        // Process user data
        const user: FarcasterUser = {
          fid,
          username: typedQuery.username || "",
          displayName: "",
          bio: "",
          pfp: "",
          url: "",
          location: "",
          twitter: "",
          github: "",
        };

        userData.messages.forEach((message) => {
          if (!message.data?.userDataBody) return;
          const { type, value } = message.data.userDataBody;
          switch (type) {
            case "USER_DATA_TYPE_PFP":
            case 1:
              user.pfp = value;
              break;
            case "USER_DATA_TYPE_DISPLAY":
            case 2:
              user.displayName = value;
              break;
            case "USER_DATA_TYPE_BIO":
            case 3:
              user.bio = value;
              break;
            case "USER_DATA_TYPE_URL":
            case 5:
              user.url = value;
              break;
            case "USER_DATA_TYPE_USERNAME":
            case 6:
              user.username = value;
              break;
            case "USER_DATA_TYPE_LOCATION":
            case 7:
              user.location = value;
              break;
            case "USER_DATA_TYPE_TWITTER":
            case 8:
              user.twitter = value;
              break;
            case "USER_DATA_TYPE_GITHUB":
            case 9:
              user.github = value;
              break;
          }
        });

        if (!user.username) {
          user.username = typedQuery.username || `user_${fid}`;
        }

        // Check connection state before streaming user profile
        if (signal.aborted) {
          return;
        }

        // Stream user profile
        await stream.writeln(`Farcaster User Profile`);
        await stream.writeln(`===================\n`);
        await stream.writeln(`Username: ${user.username}`);
        await stream.writeln(`Display Name: ${user.displayName || "N/A"}`);
        await stream.writeln(`FID: ${user.fid}`);
        if (user.bio) await stream.writeln(`Bio: ${user.bio}`);
        if (user.pfp) await stream.writeln(`Profile Picture: ${user.pfp}`);
        if (user.url) await stream.writeln(`URL: ${user.url}`);
        if (user.location) await stream.writeln(`Location: ${user.location}`);
        if (user.twitter) await stream.writeln(`Twitter: @${user.twitter}`);
        if (user.github) await stream.writeln(`GitHub: ${user.github}`);
        await stream.writeln(`\nPosts`);
        await stream.writeln(`=====\n`);

        // Setup pagination
        const reverse = typedQuery.sortOrder === "oldest" ? "false" : "true";
        const targetLimit = typedQuery.limit ? Number(typedQuery.limit) : undefined;
        const includeReplies = typedQuery.includeReplies === true;
        const pageSize = includeReplies
          ? (targetLimit ? Math.min(100, targetLimit) : 100).toString()
          : (targetLimit ? Math.min(100, Math.max(targetLimit * 2, 20)) : 100).toString();

        let pageToken: string | undefined;
        let castCount = 0;
        let processedCount = 0;

        do {
          // Check connection state before each page
          if (signal.aborted) {
            return;
          }

          const castsUrl = new URL(`${SNAPCHAIN_BASE_URL}/v1/castsByFid`);
          castsUrl.searchParams.set("fid", user.fid.toString());
          castsUrl.searchParams.set("pageSize", pageSize);
          castsUrl.searchParams.set("reverse", reverse);
          if (pageToken) {
            castsUrl.searchParams.set("pageToken", pageToken);
          }

          const castsResponse = await fetchWithTimeout(castsUrl.toString());
          const castsData = (await castsResponse.json()) as SnapchainResponse;

          for (const message of castsData.messages) {
            // Check connection state before processing each cast
            if (signal.aborted) {
              return;
            }

            if (!message.data.castAddBody) continue;

            const timestamp = message.data.timestamp;
            const text = message.data.castAddBody.text || "";
            const attachments = message.data.castAddBody.attachments || [];
            const embeds = message.data.castAddBody.embeds || [];
            const embedsDeprecated = message.data.castAddBody.embedsDeprecated || [];
            const parentCastId = message.data.castAddBody.parentCastId;

            if (!includeReplies && parentCastId) continue;

            castCount++;
            if (targetLimit && castCount > targetLimit) break;

            const cast: FarcasterCast = {
              hash: message.hash || "",
              threadHash: parentCastId?.hash || "",
              parentHash: parentCastId?.hash,
              author: {
                fid: user.fid,
                username: user.username,
              },
              text,
              timestamp:
                typeof timestamp === "number"
                  ? new Date(FARCASTER_EPOCH + timestamp * 1000).toISOString()
                  : new Date(0).toISOString(),
              attachments,
              embeds: [...embeds, ...embedsDeprecated],
              reactions: {
                likes: 0,
                recasts: 0,
              },
            };

            // Stream the cast immediately
            await stream.writeln(`[${processedCount + 1}] ${cast.timestamp}`);
            if (cast.parentHash && cast.parentCast) {
              await stream.writeln(`[Reply to]`);
              await stream.writeln(`${cast.parentCast.text}`);
              await stream.writeln(`---`);
            }
            await stream.writeln(`${cast.text}`);

            // Stream attachments and embeds immediately
            if (attachments?.length) {
              await stream.writeln(`Attachments:`);
              for (const attachment of attachments) {
                await stream.writeln(`- ${attachment.type}: ${attachment.url}`);
              }
            }

            const allEmbeds = [...(embeds || []), ...(embedsDeprecated || [])].filter((embed) => embed && embed.url);
            if (allEmbeds.length > 0) {
              await stream.writeln(`Embeds:`);
              for (const embed of allEmbeds) {
                await stream.writeln(`- ${embed.url}`);
              }
            }

            // Write the separator
            await stream.writeln(`---`);

            // Fetch reactions synchronously to ensure they stay with their cast
            if (!signal.aborted) {
              try {
                const reactions = await fetchCastReactions(cast.hash, cast.author.fid);
                await stream.writeln(`Reactions:`);
                await stream.writeln(`- Likes: ${reactions.likes}`);
                await stream.writeln(`- Recasts: ${reactions.recasts}`);
                await stream.writeln(`---`);
              } catch (error) {
                await stream.writeln(`Reactions: Error fetching reactions`);
                await stream.writeln(`---`);
              }
            }

            processedCount++;

            // Check if client disconnected after each cast
            if (signal.aborted) {
              console.log("Client disconnected, stopping stream");
              return;
            }

            // Add a small delay between casts to prevent overwhelming the stream
            await sleep(50);
          }

          pageToken = castsData.nextPageToken;
          if ((targetLimit && castCount >= targetLimit) || !pageToken) break;
        } while (pageToken);

        if (processedCount === 0) {
          await stream.writeln("No posts found.");
        }
      } catch (error) {
        if (!signal.aborted) {
          await stream.writeln(`Error: ${error instanceof Error ? error.message : "Unknown error"}`);
        }
      }
    });
  } catch (error) {
    logError("Server error:", error);
    return c.text(`Internal Server Error: ${error instanceof Error ? error.message : "Unknown error"}`, 500);
  }
});

// Enhanced caching implementation
class CacheManager {
  private cache: Map<string, { data: any; timestamp: number; etag: string }> = new Map();
  private size = 0;

  async get<T>(key: string, ttl: number): Promise<{ data: T; stale: boolean } | null> {
    const cached = this.cache.get(key);
    if (!cached) return null;

    const now = Date.now();
    const age = now - cached.timestamp;

    if (age > ttl + CACHE_CONFIG.STALE_WHILE_REVALIDATE) {
      this.cache.delete(key);
      this.size -= JSON.stringify(cached.data).length;
      return null;
    }

    return {
      data: cached.data as T,
      stale: age > ttl,
    };
  }

  async set<T>(key: string, data: T, ttl: number): Promise<void> {
    const serialized = JSON.stringify(data);
    const size = serialized.length;

    // Check if we need to evict items
    while (this.size + size > CACHE_CONFIG.MAX_CACHE_SIZE || this.cache.size >= CACHE_CONFIG.MAX_CACHE_ITEMS) {
      const entries = Array.from(this.cache.entries()).sort(([, a], [, b]) => a.timestamp - b.timestamp);
      if (entries.length === 0) break;

      const firstEntry = entries[0];
      if (!firstEntry) break;

      const oldestKey = firstEntry[0];
      const evicted = this.cache.get(oldestKey);
      if (!evicted) break;

      this.size -= JSON.stringify(evicted.data).length;
      this.cache.delete(oldestKey);
    }

    this.cache.set(key, {
      data,
      timestamp: Date.now(),
      etag: await this.generateETag(data),
    });
    this.size += size;
  }

  private async generateETag(data: any): Promise<string> {
    const serialized = JSON.stringify(data);
    const encoder = new TextEncoder();
    const hashBuffer = await crypto.subtle.digest("SHA-256", encoder.encode(serialized));
    return Array.from(new Uint8Array(hashBuffer))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }
}

const cacheManager = new CacheManager();

// Batch processor for efficient data fetching
class BatchProcessor<T> {
  private queue: Array<{ key: string; resolve: (value: T) => void; reject: (error: any) => void }> = [];
  private processing = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(private options = BATCH_CONFIG) {}

  async add(key: string, fetchFn: () => Promise<T>): Promise<T> {
    // If queue is full, process immediately
    if (this.queue.length >= this.options.MAX_BATCH_SIZE) {
      await this.process();
    }

    return new Promise<T>((resolve, reject) => {
      this.queue.push({ key, resolve, reject });

      // Start processing timer if not already running
      if (!this.processing && !this.timer) {
        this.timer = setTimeout(() => void this.process(), this.options.BATCH_TIMEOUT);
      }

      // Execute the fetch function immediately
      void fetchFn().then(resolve).catch(reject);
    });
  }

  private async process(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;

    this.processing = true;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }

    try {
      const currentBatch = this.queue;
      this.queue = [];

      await Promise.all(
        currentBatch.map(async ({ key, resolve, reject }) => {
          try {
            // Each item processes independently
            const result = await this.processSingleItem(key);
            resolve(result);
          } catch (error) {
            reject(error);
          }
        })
      );
    } finally {
      this.processing = false;
    }
  }

  protected async processSingleItem(_key: string): Promise<T> {
    throw new Error("processSingleItem must be implemented by subclasses");
  }
}

// Specialized batch processor for user data
class UserDataBatchProcessor extends BatchProcessor<FarcasterUser> {
  protected async processSingleItem(fid: string): Promise<FarcasterUser> {
    const response = await fetchWithTimeout(`${SNAPCHAIN_BASE_URL}/v1/userDataByFid?fid=${fid}`);
    if (!response?.ok) {
      throw new Error(`Failed to fetch user data: ${response?.status} ${response?.statusText}`);
    }
    const data = (await response.json()) as SnapchainResponse;
    return processUserData(data);
  }
}

// Specialized batch processor for reactions
class ReactionsBatchProcessor extends BatchProcessor<{ likes: number; recasts: number }> {
  protected async processSingleItem(key: string): Promise<{ likes: number; recasts: number }> {
    const [targetFid, castHash] = key.split(":");
    if (!targetFid || !castHash) {
      throw new Error("Invalid key format for reactions batch processor");
    }

    const [likesResponse, recastsResponse] = await Promise.all([
      fetchWithTimeout(
        `${SNAPCHAIN_BASE_URL}/v1/reactionsByCast?target_fid=${targetFid}&target_hash=${castHash}&reaction_type=Like`
      ),
      fetchWithTimeout(
        `${SNAPCHAIN_BASE_URL}/v1/reactionsByCast?target_fid=${targetFid}&target_hash=${castHash}&reaction_type=Recast`
      ),
    ]);

    if (!likesResponse?.ok || !recastsResponse?.ok) {
      throw new Error("Failed to fetch reactions");
    }

    const likesData = (await likesResponse.json()) as SnapchainResponse;
    const recastsData = (await recastsResponse.json()) as SnapchainResponse;

    return {
      likes: likesData.messages?.length || 0,
      recasts: recastsData.messages?.length || 0,
    };
  }
}

// Create instances of the specialized batch processors
const userDataBatchProcessor = new UserDataBatchProcessor();
const reactionsBatchProcessor = new ReactionsBatchProcessor();

// Helper function to process user data
function processUserData(data: SnapchainResponse): FarcasterUser {
  const user: FarcasterUser = {
    fid: 0,
    username: "",
    displayName: "",
    bio: "",
    pfp: "",
    url: "",
    location: "",
    twitter: "",
    github: "",
  };

  data.messages.forEach((message) => {
    if (!message.data?.userDataBody) return;
    const { type, value } = message.data.userDataBody;
    switch (type) {
      case "USER_DATA_TYPE_PFP":
      case 1:
        user.pfp = value;
        break;
      case "USER_DATA_TYPE_DISPLAY":
      case 2:
        user.displayName = value;
        break;
      case "USER_DATA_TYPE_BIO":
      case 3:
        user.bio = value;
        break;
      case "USER_DATA_TYPE_URL":
      case 5:
        user.url = value;
        break;
      case "USER_DATA_TYPE_USERNAME":
      case 6:
        user.username = value;
        break;
      case "USER_DATA_TYPE_LOCATION":
      case 7:
        user.location = value;
        break;
      case "USER_DATA_TYPE_TWITTER":
      case 8:
        user.twitter = value;
        break;
      case "USER_DATA_TYPE_GITHUB":
      case 9:
        user.github = value;
        break;
    }
  });

  return user;
}

export default app;
