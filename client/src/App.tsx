import { useState, useEffect } from "react";
import type { FarcasterQueryParams } from "shared";
import "./App.css";

// Server URL configuration
const SERVER_URL = import.meta.env.PROD ? "https://api.llm-fid.fun" : "http://localhost:5173/api";

// Custom debounce hook
function useDebounce<T>(value: T, delay: number): T {
  const [debouncedValue, setDebouncedValue] = useState<T>(value);

  useEffect(() => {
    const timer = setTimeout(() => {
      setDebouncedValue(value);
    }, delay);

    return () => {
      clearTimeout(timer);
    };
  }, [value, delay]);

  return debouncedValue;
}

function App() {
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [generatedUrl, setGeneratedUrl] = useState<string | null>(null);
  const [params, setParams] = useState<FarcasterQueryParams>({
    limit: 10,
    includeReplies: false,
    all: false,
    sortOrder: "newest",
    includeReactions: false,
    includeParents: false,
  });

  // Debounce the input value
  const debouncedInput = useDebounce(input, 500);

  // Generate URL whenever debounced input or params change
  useEffect(() => {
    if (!debouncedInput.trim()) {
      setGeneratedUrl(null);
      return;
    }

    try {
      const isFid = !isNaN(Number(debouncedInput));
      const queryParams = new URLSearchParams();

      // Add the main identifier
      if (isFid) {
        queryParams.set("fid", debouncedInput);
      } else {
        // Remove @ symbol if present and normalize to lowercase
        const cleanUsername = debouncedInput.trim().replace(/^@/, "").toLowerCase();
        queryParams.set("username", cleanUsername);
      }

      // Add optional parameters
      if (params.limit && !params.all) queryParams.set("limit", params.limit.toString());
      queryParams.set("includeReplies", params.includeReplies ? "true" : "false");
      if (params.all) queryParams.set("all", "true");
      if (params.sortOrder) queryParams.set("sortOrder", params.sortOrder);
      if (params.includeReactions) queryParams.set("includeReactions", "true");
      if (params.includeParents) queryParams.set("includeParents", "true");

      const url = `${SERVER_URL}?${queryParams.toString()}`;
      setGeneratedUrl(url);
    } catch (err) {
      setGeneratedUrl(null);
    }
  }, [debouncedInput, params]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!generatedUrl) return;

    setIsLoading(true);
    setError(null);

    try {
      // Normalize the URL to ensure username is lowercase
      const url = new URL(generatedUrl);
      if (url.searchParams.has("username")) {
        const username = url.searchParams.get("username");
        if (username) {
          url.searchParams.set("username", username.toLowerCase());
        }
      }

      // Open in new tab with the normalized URL
      const newWindow = window.open(url.toString(), "_blank");
      if (!newWindow) {
        setError("Please allow popups for this site to generate the file");
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  // Helper function to get loading message based on params
  const getLoadingMessage = () => {
    if (!isLoading) return null;
    const messages = [];
    if (params.all) {
      messages.push("Fetching all posts");
    } else if (params.limit && params.limit > 50) {
      messages.push(`Fetching ${params.limit} posts`);
    }
    if (params.includeReplies) {
      messages.push("Including replies");
    }
    return messages.length > 0 ? messages.join(" • ") : "Generating...";
  };

  return (
    <div className='container'>
      <h1>LLM-[FID].txt</h1>
      <p>Generate a llm.txt file for a Farcaster profile</p>

      <h3>Note</h3>
      <p>
        The file generation may take longer when:
        <ul>
          <li>Fetching all posts</li>
          <li>Including replies</li>
          <li>Requesting a large number of posts</li>
        </ul>
        Please be patient as the file streams in.
      </p>

      <form onSubmit={handleSubmit} className='form'>
        <div className='form-section'>
          <h2>Input</h2>
          <div className='input-group'>
            <input
              type='text'
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder='Enter FID or username'
              disabled={isLoading}
              required
            />
            <button type='submit' disabled={isLoading || !generatedUrl}>
              {getLoadingMessage() || "Generate"}
            </button>
          </div>
          {generatedUrl && (
            <p>
              <small>{generatedUrl}</small>
            </p>
          )}
        </div>

        <div className='form-section'>
          <h2>Options</h2>
          <div className='options'>
            <div className='control-group'>
              <label>
                <span>Post Limit</span>
                <input
                  type='number'
                  value={params.limit || ""}
                  onChange={(e) => setParams({ ...params, limit: e.target.value ? Number(e.target.value) : 10 })}
                  min='1'
                  disabled={params.all}
                />
              </label>
            </div>

            <div className='control-group'>
              <label>
                <span>Sort Order</span>
                <select
                  value={params.sortOrder}
                  onChange={(e) => setParams({ ...params, sortOrder: e.target.value as "newest" | "oldest" })}
                >
                  <option value='newest'>Newest First</option>
                  <option value='oldest'>Oldest First</option>
                </select>
              </label>
            </div>

            <div className='control-group'>
              <label className='checkbox-label'>
                <input
                  type='checkbox'
                  checked={params.all}
                  onChange={(e) => {
                    setParams((prev) => ({
                      ...prev,
                      all: e.target.checked,
                      limit: e.target.checked ? undefined : 10,
                      includeReplies: e.target.checked ? false : prev.includeReplies,
                      includeReactions: e.target.checked ? false : prev.includeReactions,
                      includeParents: e.target.checked ? false : prev.includeParents,
                    }));
                  }}
                />
                <div>
                  <span>Fetch All Top-Level Casts</span>
                  <small>Ignores post limit, excludes replies and reactions</small>
                </div>
              </label>
            </div>

            <div className='control-group'>
              <label className='checkbox-label'>
                <input
                  type='checkbox'
                  checked={params.includeReactions}
                  onChange={(e) => setParams({ ...params, includeReactions: e.target.checked })}
                  disabled={params.all}
                />
                <div>
                  <span>Include Reactions</span>
                  <small>Show likes and recasts</small>
                </div>
              </label>
            </div>

            <div className='control-group'>
              <label className='checkbox-label'>
                <input
                  type='checkbox'
                  checked={params.includeReplies}
                  onChange={(e) => setParams({ ...params, includeReplies: e.target.checked })}
                  disabled={params.all}
                />
                <div>
                  <span>Include Replies</span>
                  <small>Show reply threads (disabled when fetching all casts)</small>
                </div>
              </label>
            </div>

            <div className='control-group'>
              <label className='checkbox-label'>
                <input
                  type='checkbox'
                  checked={params.includeParents}
                  onChange={(e) => setParams({ ...params, includeParents: e.target.checked })}
                  disabled={params.all || !params.includeReplies}
                />
                <div>
                  <span>Include Parent Casts</span>
                  <small>Show parent cast text for replies (only available when replies are enabled)</small>
                </div>
              </label>
            </div>
          </div>
        </div>
      </form>

      {error && <div className='error'>{error}</div>}

      <p>
        <small>
          Built by <a href='https://warpcast.com/iammatthias'>@iammatthias</a>. Open source:{" "}
          <a href='https://github.com/iammatthias/llm-fid-txt'>github.com/iammatthias/llm-fid-txt</a>
        </small>
      </p>
    </div>
  );
}

export default App;
