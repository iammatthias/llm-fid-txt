# LLM FID TXT

Generate a `llm-[fid].txt` file for any Farcaster profile. This tool helps you create a text file containing a user's profile information and their recent casts, formatted for use with language models.

> This project was scaffolded using [bhvr.dev](https://bhvr.dev)

## 🚀 Features

- Generate `llm-[fid].txt` files for any Farcaster profile
- Search by username or FID
- Customize the number of casts to include
- Sort casts by newest or oldest
- Include or exclude replies
- Optional reactions (likes & recasts)
- Optional parent casts for replies

## ⚠️ Limitations

- Reactions and parent casts are only available when fetching a limited number of casts (not available with "All casts")
- Parent casts are fetched in small batches to prevent rate limiting
- Reactions are fetched in small batches to prevent rate limiting

## 🏗️ Prerequisites

- A Farcaster account (for using the application)

## 🚀 Getting Started

1. Visit [llm-fid.fun](https://llm-fid.fun)
2. Enter a Farcaster username or FID
3. Customize your options:
   - Number of casts to include (1-1000)
   - Sort order (newest or oldest)
   - Include replies (yes/no)
   - Include reactions (likes & recasts)
   - Include parent casts for replies
4. Click "Generate" to create your `llm-[fid].txt` file

## 📝 Form Options

### Search Options

- **Username**: Enter any Farcaster username
- **FID**: Enter any Farcaster ID number

### Output Options

- **Number of Casts**:
  - Enter a number to limit the output
  - Select "All" to include every cast
- **Sort Order**:
  - Newest: Most recent casts first
  - Oldest: Oldest casts first
- **Include Replies**:
  - Yes: Include all casts including replies
  - No: Only include top-level casts
- **Include Reactions**:
  - Yes: Include likes and recasts for each cast
  - No: Skip reaction counts
  - Note: Only available when fetching a limited number of casts
- **Include Parent Casts**:
  - Yes: Include the parent cast text for replies
  - No: Skip parent cast text
  - Note: Only available when fetching a limited number of casts

## 🌐 API Usage

You can also use the API directly:

```bash
# Get a limited number of casts with reactions and parents
GET https://api.llm-fid.fun/mcp?username=username&limit=10&sortOrder=newest&includeReplies=true&includeReactions=true&includeParents=true

# Get all available casts (reactions and parents disabled)
GET https://api.llm-fid.fun/mcp?username=username&sortOrder=newest&includeReplies=true&all=true
```

### API Parameters

- `username` (string, optional): Farcaster username
- `fid` (number, optional): Farcaster ID
- `limit` (number, optional): Number of casts to return (only used when all=false)
- `sortOrder` (string, optional): "newest" or "oldest"
- `includeReplies` (boolean, optional): true or false
- `includeReactions` (boolean, optional): true or false (only used when all=false)
- `includeParents` (boolean, optional): true or false (only used when all=false)
- `all` (boolean, optional): When true, returns all available casts (disables reactions and parents)

## 📄 License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## 👥 Authors

- **iammatthias** - _Initial work_ - [GitHub](https://github.com/iammatthias)

## 🙏 Acknowledgments

- [Farcaster](https://farcaster.xyz) for the platform
- [bhvr.dev](https://bhvr.dev) for the monorepo starter template
