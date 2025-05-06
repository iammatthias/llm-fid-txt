import { Hono } from "hono";
import { cors } from "hono/cors";
import type { FarcasterResponse, UserNameProof, FarcasterUser, FarcasterCast, FarcasterQueryParams } from "shared";

// Use the correct Pinata hub URL for Snapchain API
const SNAPCHAIN_BASE_URL = process.env.SNAPCHAIN_BASE_URL || "https://hub.pinata.cloud";
const API_TIMEOUT = 10000; // 10 seconds
// Farcaster epoch starts on January 1, 2021
const FARCASTER_EPOCH = new Date("2021-01-01T00:00:00.000Z").getTime();

interface SnapchainMessage {
  data: {
    type: string;
    fid: number;
    timestamp: number;
    network: string;
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
  };
}

interface SnapchainResponse {
  messages: SnapchainMessage[];
  nextPageToken?: string;
}

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

// Helper function to fetch with timeout
async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
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
      // Add Cloudflare-specific options
      cf: {
        cacheTtl: 300, // Cache for 5 minutes
        cacheEverything: true,
        resolveOverride: "hub.pinata.cloud", // Force DNS resolution to Pinata hub
      },
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`API request failed: ${response.status} ${response.statusText} - ${errorText}`);
    }

    clearTimeout(timeoutId);
    return response;
  } catch (error) {
    clearTimeout(timeoutId);
    if (error instanceof Error && error.name === "AbortError") {
      throw new Error(`Request timed out after ${API_TIMEOUT}ms`);
    }
    // Add more context to the error
    if (error instanceof Error) {
      error.message = `Failed to fetch from ${url}: ${error.message}`;
    }
    throw error;
  }
}

// Helper function to resolve FID from username
async function resolveFid(username: string): Promise<number> {
  if (!username) {
    throw new Error("Username is required");
  }

  // Normalize username to lowercase
  const normalizedUsername = username.toLowerCase();

  try {
    const response = await fetchWithTimeout(
      `${SNAPCHAIN_BASE_URL}/v1/userNameProofByName?name=${encodeURIComponent(normalizedUsername)}`
    );

    if (!response.ok) {
      // If the username proof fails, try to get the user data directly
      const userResponse = await fetchWithTimeout(
        `${SNAPCHAIN_BASE_URL}/v1/userDataByUsername?username=${encodeURIComponent(normalizedUsername)}`
      );

      if (!userResponse.ok) {
        throw new Error(`Failed to resolve username: ${response.status} ${response.statusText}`);
      }

      const userData = (await userResponse.json()) as { fid: number };
      if (!userData.fid || userData.fid <= 0) {
        throw new Error(`Invalid FID returned for username: ${username}`);
      }

      return userData.fid;
    }

    const data = (await response.json()) as UserNameProof;
    if (!data.fid || data.fid <= 0) {
      throw new Error(`Invalid FID returned for username: ${username}`);
    }

    return data.fid;
  } catch (error) {
    throw error;
  }
}

async function fetchUserData(fidOrUsername: number | string, params: FarcasterQueryParams): Promise<FarcasterResponse> {
  let fid: number;

  if (typeof fidOrUsername === "number") {
    if (fidOrUsername <= 0) {
      throw new Error("Invalid FID provided");
    }
    fid = fidOrUsername;
  } else {
    try {
      // Remove @ symbol if present and normalize to lowercase
      const sanitizedUsername = (fidOrUsername.startsWith("@") ? fidOrUsername.slice(1) : fidOrUsername).toLowerCase();
      fid = await resolveFid(sanitizedUsername);
    } catch (error) {
      throw new Error(`Failed to resolve username: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  }

  // Use reverse=true for newest first, which is our default
  const reverse = params.sortOrder === "oldest" ? "false" : "true";
  // Only use limit if all is not true
  const targetLimit = params.all === true ? 1000 : params.limit || 10;
  const includeReplies = params.includeReplies === true;

  // Calculate optimal page size based on whether we're filtering replies
  const pageSize =
    params.all === true
      ? "1000"
      : includeReplies
      ? targetLimit.toString()
      : Math.min(1000, Math.max(targetLimit * 2, 20)).toString();

  let pageToken: string | undefined;
  let allCasts: FarcasterCast[] = [];
  let nonReplyCasts: FarcasterCast[] = [];

  try {
    // First fetch user data
    const userResponse = await fetchWithTimeout(`${SNAPCHAIN_BASE_URL}/v1/userDataByFid?fid=${fid}`);

    if (!userResponse.ok) {
      const errorText = await userResponse.text();
      throw new Error(
        `Failed to fetch user data: ${userResponse.status} ${userResponse.statusText}${
          errorText ? ` - ${errorText}` : ""
        }`
      );
    }

    // Parse user data
    const userData = (await userResponse.json()) as SnapchainResponse;
    if (!Array.isArray(userData.messages)) {
      throw new Error("Invalid user data response format: messages array missing");
    }

    // Process user data
    const user: FarcasterUser = {
      fid,
      username: typeof fidOrUsername === "string" ? fidOrUsername : "",
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

    // If no username was found, use the provided username or a fallback
    if (!user.username) {
      user.username = typeof fidOrUsername === "string" ? fidOrUsername : `user_${fid}`;
    }

    // Fetch casts with pagination
    do {
      const castsUrl = new URL(`${SNAPCHAIN_BASE_URL}/v1/castsByFid`);
      castsUrl.searchParams.set("fid", user.fid.toString());
      castsUrl.searchParams.set("reverse", reverse);
      castsUrl.searchParams.set("pageSize", pageSize);
      if (pageToken) {
        castsUrl.searchParams.set("pageToken", pageToken);
      }

      const castsResponse = await fetchWithTimeout(castsUrl.toString());

      if (!castsResponse.ok) {
        const errorText = await castsResponse.text();
        throw new Error(
          `Failed to fetch casts: ${castsResponse.status} ${castsResponse.statusText}${
            errorText ? ` - ${errorText}` : ""
          }`
        );
      }

      const castsData = (await castsResponse.json()) as SnapchainResponse;

      // Process casts
      for (const message of castsData.messages) {
        if (!message.data.castAddBody) continue;

        const timestamp = message.data.timestamp;
        const text = message.data.castAddBody.text || "";
        const attachments = message.data.castAddBody.attachments || [];
        const embeds = message.data.castAddBody.embeds || [];
        const embedsDeprecated = message.data.castAddBody.embedsDeprecated || [];
        const parentCastId = message.data.castAddBody.parentCastId;

        const cast: FarcasterCast = {
          hash: text.slice(0, 8) || "",
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

        allCasts.push(cast);

        // If we're not including replies, track non-reply casts separately
        if (!includeReplies && !cast.parentHash) {
          nonReplyCasts.push(cast);
        }
      }

      // Get next page token if available
      pageToken = castsData.nextPageToken;

      // Break conditions:
      // 1. If we're fetching all casts, continue until no more pages
      // 2. If we're including replies, break when we have enough total casts
      // 3. If we're excluding replies, break when we have enough non-reply casts
      if (params.all !== true) {
        if (includeReplies && allCasts.length >= targetLimit) {
          break;
        } else if (!includeReplies && nonReplyCasts.length >= targetLimit) {
          break;
        }
      }
    } while (pageToken);

    // Use the appropriate array based on whether we're including replies
    const finalCasts = includeReplies ? allCasts : nonReplyCasts;

    // Apply limit if needed
    if (params.all !== true && params.limit) {
      const limit = Math.max(1, Math.min(params.limit, 1000)); // Ensure limit is between 1 and 1000
      return { user, casts: finalCasts.slice(0, limit) };
    }

    return { user, casts: finalCasts };
  } catch (error) {
    throw error;
  }
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
      if (cast.attachments?.length) {
        output += `\nAttachments:\n`;
        cast.attachments.forEach((attachment) => {
          output += `- ${attachment.type}: ${attachment.url}\n`;
        });
      }
      if (cast.embeds?.length) {
        output += `\nEmbeds:\n`;
        cast.embeds.forEach((embed) => {
          output += `- ${embed.url}\n`;
        });
      }
      output += `\n---\n\n`;
    });
  }

  return output;
}

// Main API endpoint
app.get("/", async (c) => {
  try {
    const query = c.req.query();
    console.log("Received query params:", query); // Debug log

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

    const data = await fetchUserData(typedQuery.fid ? typedQuery.fid : typedQuery.username!, typedQuery);
    const textOutput = formatTextOutput(data);

    c.header("Content-Type", "text/plain");
    return c.text(textOutput);
  } catch (error) {
    console.error("Server error:", error); // Debug log
    return c.text(`Internal Server Error: ${error instanceof Error ? error.message : "Unknown error"}`, 500);
  }
});

export default app;
