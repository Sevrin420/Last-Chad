# Quest Publisher Server Setup

This backend server enables the Quest Builder to publish quests directly to GitHub.

## Features

✅ Publish quests to GitHub with one click
✅ Auto-generate playable quest HTML pages
✅ Store quest images in organized folders
✅ Create git commits automatically
✅ Host quests at `https://lastchad.xyz/quests/[quest-name]/`

## Prerequisites

- Node.js v16+ installed
- GitHub Personal Access Token (with `repo` and `workflow` permissions)
- Git configured on your machine

## Setup Instructions

### 1. Install Dependencies

```bash
npm install
```

This installs:
- `express` - Web server framework
- `@octokit/rest` - GitHub API client
- `cors` - Cross-origin resource sharing
- `dotenv` - Environment variable management

### 2. Create GitHub Personal Access Token

1. Go to [GitHub Settings → Developer settings → Personal access tokens](https://github.com/settings/tokens)
2. Click "Generate new token (classic)"
3. Give it a name: `Last Chad Quest Publisher`
4. Select scopes:
   - ✅ `repo` (full control of private/public repositories)
   - ✅ `workflow` (update GitHub Action workflows)
5. Click "Generate token"
6. **Copy the token immediately** (you won't see it again)

### 3. Create .env File

Create a `.env` file in the project root:

```bash
cp .env.example .env
```

Then edit `.env` and add your GitHub token:

```
GITHUB_TOKEN=ghp_your_token_here
GITHUB_OWNER=Sevrin420
GITHUB_REPO=Last-Chad
GITHUB_BRANCH=main
PORT=5000
NODE_ENV=development
```

**⚠️ IMPORTANT:** Never commit `.env` to git! It's already in `.gitignore`.

### 4. Start the Server

```bash
# Development mode (with auto-reload)
npm run dev

# Production mode
npm start
```

The server will start on `http://localhost:5000`

### 5. Use the Quest Builder

1. Navigate to `http://localhost:3000/quest-builder.html` (or your local dev server)
2. Build your quest with sections, choices, and images
3. Click **"💾 Save Quest"**
4. Confirm the publish dialog
5. Watch the server create the quest and push to GitHub!

## How It Works

### Quest Publishing Flow

```
User clicks "Save Quest"
         ↓
Browser sends quest data (name + sections with images)
         ↓
Backend receives POST /api/publish-quest
         ↓
Generate quest player HTML
         ↓
Convert base64 images to PNG files
         ↓
Create GitHub commit with all files
         ↓
Push to main branch
         ↓
Files appear at: quests/quest-name/
```

### Generated Quest Structure

```
quests/
└── my-epic-quest/
    ├── index.html          (playable quest)
    ├── data.json           (quest metadata)
    └── images/
        ├── 1234567890.png  (section 1 image)
        ├── 1234567891.png  (section 2 image)
        └── dice-1234567892.png (dice image)
```

## Environment Variables

| Variable | Required | Example | Description |
|----------|----------|---------|-------------|
| `GITHUB_TOKEN` | ✅ Yes | `ghp_xxxx...` | GitHub Personal Access Token |
| `GITHUB_OWNER` | ✅ Yes | `Sevrin420` | GitHub username |
| `GITHUB_REPO` | ✅ Yes | `Last-Chad` | Repository name |
| `GITHUB_BRANCH` | ✅ Yes | `main` | Branch to push to |
| `PORT` | No | `5000` | Server port (default: 5000) |
| `NODE_ENV` | No | `development` | Environment mode |

## Troubleshooting

### "401 Unauthorized" Error
- Your GitHub token is invalid or expired
- Check that `GITHUB_TOKEN` in `.env` is correct
- Regenerate the token if necessary

### "403 Forbidden" Error
- Token doesn't have required permissions
- Regenerate with `repo` and `workflow` scopes

### Images not showing in quest
- Check that images are base64-encoded in the quest data
- Verify image paths: `images/[section-id].png`
- Check that images were pushed to GitHub

### Quest not accessible at URL
- Give GitHub a minute to process the push
- Ensure `GITHUB_OWNER` and `GITHUB_REPO` are correct
- Check that the quest folder was created in `/quests/`

## Security Notes

🔒 **Never commit `.env` to GitHub!**

- `.env` is in `.gitignore` to prevent accidents
- The GitHub token should be kept private
- For production, use GitHub Secrets or environment variables

## Advanced: Using in Production

For production deployment (e.g., on a server):

1. **Use environment variables instead of `.env`:**
   ```bash
   export GITHUB_TOKEN=ghp_xxxx...
   export GITHUB_OWNER=Sevrin420
   # etc.
   ```

2. **Use a process manager like PM2:**
   ```bash
   npm install -g pm2
   pm2 start server.js --name "quest-server"
   ```

3. **Enable HTTPS** with a reverse proxy (nginx/Apache)

4. **Use GitHub App Tokens** (more secure than personal tokens)

## API Reference

### POST /api/publish-quest

Publishes a quest to GitHub.

**Request Body:**
```json
{
  "questName": "The Forest Adventure",
  "sections": [
    {
      "id": 1234567890,
      "name": "Forest Entrance",
      "dialogue": "You enter a dark forest...",
      "photo": "data:image/png;base64,...",
      "selectedChoice": "double",
      "button1Name": "Go Left",
      "button2Name": "Go Right",
      "choice1NextSectionId": 1234567891,
      "choice2NextSectionId": 1234567892
    }
    // ... more sections
  ]
}
```

**Success Response (200):**
```json
{
  "success": true,
  "message": "Quest \"The Forest Adventure\" published successfully!",
  "questUrl": "https://lastchad.xyz/quests/the-forest-adventure/",
  "questPath": "quests/the-forest-adventure",
  "commit": "abc123def456..."
}
```

**Error Response (400/500):**
```json
{
  "error": "Failed to publish quest",
  "details": "Error message here"
}
```

## Support

For issues or questions:
1. Check the troubleshooting section
2. Review the `.env` configuration
3. Check server logs for detailed error messages
4. Ensure GitHub token has correct permissions
