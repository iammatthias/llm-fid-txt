# Farcaster Text API

A simple API that returns Farcaster user profiles and posts in a clean text format.

## Installation

```sh
bun install
```

## Development

```sh
bun run dev
```

## API Usage

The API is available at `https://api.llm-fid.fun` and accepts the following query parameters:

### Required Parameters

- `username` - Farcaster username (e.g., "jacob")
- OR `fid` - Farcaster ID number

### Optional Parameters

- `limit` - Number of posts to return (default: 10, max: 1000)
- `includeReplies` - Include replies in the output (default: false)
- `sortOrder` - Sort order for posts ("newest" or "oldest", default: "newest")
- `all` - Return all available posts up to 1000 (default: false)

### Example Requests

Get latest 10 posts from a user:

```
https://api.llm-fid.fun?username=jacob&limit=10&includeReplies=false&sortOrder=newest
```

Get all posts from a user:

```
https://api.llm-fid.fun?username=jacob&all=true
```

Get oldest posts including replies:

```
https://api.llm-fid.fun?username=jacob&limit=20&includeReplies=true&sortOrder=oldest
```

### Response Format

The API returns a plain text response with the following format:

```
Farcaster User Profile
===================

Username: username
Display Name: Display Name
FID: 12345
Bio: User's bio
Profile Picture: https://...
URL: https://...
Location: Location
Twitter: @twitter
GitHub: github

Posts
=====

[1] 2024-03-20T12:34:56.789Z
Post content here

Attachments:
- image: https://...

Embeds:
- https://...

---

[2] 2024-03-19T12:34:56.789Z
[Reply]
Reply content here

---
```
