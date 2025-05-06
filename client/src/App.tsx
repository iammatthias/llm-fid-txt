import { useState, useEffect } from "react";
import type { MCPQueryParams } from "shared";
import "./App.css";

// Server URL configuration
const SERVER_URL = import.meta.env.PROD ? "https://api.llm-fid.fun" : "http://localhost:3000";

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
  const [params, setParams] = useState<MCPQueryParams>({
    limit: 10,
    includeReplies: false,
    all: false,
    sortOrder: "newest",
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
        queryParams.set("username", debouncedInput);
      }

      // Add optional parameters
      if (params.limit) queryParams.set("limit", params.limit.toString());
      queryParams.set("includeReplies", params.includeReplies ? "true" : "false");
      if (params.all) queryParams.set("all", "true");
      if (params.sortOrder) queryParams.set("sortOrder", params.sortOrder);

      setGeneratedUrl(`${SERVER_URL}/mcp?${queryParams.toString()}`);
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
      // Open in new tab with the full server URL
      window.open(generatedUrl, "_blank");
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className='container'>
      <h1>LLM-[FID].txt</h1>
      <p>Generate a llm.txt file for a Farcaster profile</p>

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
              {isLoading ? "Generating..." : "Generate"}
            </button>
          </div>
          {generatedUrl && (
            <div className='url-display'>
              <span className='url-text'>{generatedUrl}</span>
            </div>
          )}
        </div>

        <div className='form-section'>
          <h2>Options</h2>
          <div className='controls'>
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
                <small>Default: 10 posts</small>
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
                <small>Default: Newest First</small>
              </label>
            </div>

            <div className='control-group checkboxes'>
              <label>
                <input
                  type='checkbox'
                  checked={params.all}
                  onChange={(e) => setParams({ ...params, all: e.target.checked })}
                />
                <div>
                  <span>Fetch All Posts</span>
                  <small>Ignores post limit</small>
                </div>
              </label>

              <label>
                <input
                  type='checkbox'
                  checked={params.includeReplies}
                  onChange={(e) => setParams({ ...params, includeReplies: e.target.checked })}
                />
                <div>
                  <span>Include Replies</span>
                  <small>Show reply threads</small>
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
