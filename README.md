# ISO Chatbot

A lightweight, multimodal AI chatbot web application built with **Flask** and vanilla JavaScript, powered by **OpenRouter** (`nvidia/nemotron-3.5-super-vl:free`) with multi-turn reasoning and rich file attachment support.

## Features

- **Multimodal Vision & Reasoning:** Uses `nvidia/nemotron-3.5-super-vl:free` via OpenRouter with `reasoning` enabled and preserves `reasoning_details` unmodified across turns so the model maintains its chain of thought on follow-up questions.
- **Broad File & Archive Support:**
  - **Images:** PNG, JPG, JPEG, WebP, and GIF (converted to base64 vision blocks).
  - **Documents:** PDF (`pypdf`) and Word `.docx` files (`python-docx`, including table extraction).
  - **Archives:** `.zip` files extracted in memory with recursive processing and built-in size/file-count safety limits.
  - **Text & Code:** `.txt`, `.md`, `.csv`, `.json`, `.py`, `.js`, `.html`, `.css`, and other UTF-8 text files.
- **Modern Chat UX:**
  - Multi-file picker, drag-and-drop onto the workspace, and clipboard image paste (`Ctrl+V`).
  - Attachment preview bar with image thumbnails, file icons, sizes, and remove controls.
  - Markdown-rendered responses and a built-in Light/Dark theme switcher.
- **Production Ready:** Includes rate limiting, optional Redis support, Content Security Policy (CSP) headers, and a `vercel.json` configuration for one-click serverless deployment.

## Project Structure

```text
ISO-chatbot/
├── app.py                # Flask backend, file extractors, and OpenRouter API integration
├── requirements.txt      # Python dependencies
├── vercel.json           # Vercel serverless deployment configuration
├── .gitignore            # Git ignore rules
├── templates/
│   └── index.html        # Main chat UI template
└── public/
    ├── app.js            # Frontend chat logic, file uploads, and history management
    ├── style.css         # Application styling and attachment UI
    └── theme.js          # Theme persistence and switcher
```

## Prerequisites

- Python 3.9 or higher
- An [OpenRouter](https://openrouter.ai/) API key

## Local Setup

1. **Clone or extract the repository:**
   ```bash
   cd ISO-chatbot
   ```

2. **Create and activate a virtual environment (recommended):**
   ```bash
   python -m venv venv
   # macOS / Linux
   source venv/bin/activate
   # Windows
   venv\Scripts\activate
   ```

3. **Install dependencies:**
   ```bash
   pip install -r requirements.txt
   ```

4. **Configure environment variables:**
   Create a `.env` file in the project root:
   ```env
   OPENROUTER_API_KEY=your_openrouter_api_key_here
   MAX_UPLOAD_MB=16
   ```

5. **Run the application:**
   ```bash
   python app.py
   ```
   Open your browser and navigate to `http://127.0.0.1:5000`.

## Environment Variables

| Variable | Required | Default | Description |
| :--- | :--- | :--- | :--- |
| `OPENROUTER_API_KEY` | Yes | — | Your OpenRouter API key for authenticating requests. |
| `MAX_UPLOAD_MB` | No | `16` | Maximum allowed request upload size in megabytes. |
| `REDIS_URL` | No | — | Optional Redis connection URL for distributed rate limiting. |

## Deploying to Vercel

This project includes a `vercel.json` file for straightforward deployment:

1. Push your repository to GitHub, GitLab, or Bitbucket (or deploy directly using the [Vercel CLI](https://vercel.com/docs/cli)).
2. Import the project in the Vercel dashboard.
3. Add `OPENROUTER_API_KEY` under **Settings → Environment Variables**.
4. Deploy.

> **Note on Upload Limits:** Vercel serverless functions enforce a hard **4.5 MB** request body limit. When running on Vercel, keep total file uploads per message under ~4 MB.

## License

This project is provided as-is for personal and educational use. Feel free to customize and extend it for your needs.
