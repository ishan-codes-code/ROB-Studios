ROB — Real-time Observer & Broadcaster

An AI-powered esports commentary application that transforms gameplay into intelligent, context-aware, broadcast-ready commentary.

ROB is a desktop application designed to observe gameplay, understand what is happening across a match, identify meaningful events, and generate natural commentary with optional AI-powered voice narration.

Rather than treating every frame as an isolated image, ROB maintains match context, tracks developments, and uses visual evidence to produce relevant commentary.

Built for esports creators, tournament organizers, streamers, and competitive gaming broadcasts.

---

Overview

Traditional AI vision systems often analyze individual frames without understanding how gameplay evolves. ROB takes a different approach.

It combines adaptive visual analysis, persistent match-state tracking, evidence-aware event detection, streaming commentary generation, and voice synthesis into one integrated workflow.

From importing gameplay footage to exporting a finished video with commentary, ROB provides a complete desktop workspace for AI-assisted esports broadcasting.

Features

1. Intelligent Gameplay Analysis

- Adaptive Vision Sampling: Dynamically adjusts frame sampling frequency based on gameplay activity.
- Structured Observations: Converts visual analysis into validated, structured observation data.
- Match-State Tracking: Maintains contextual understanding across multiple moments in a match.
- Event Detection: Identifies meaningful gameplay developments using evidence-based rules.
- Game-Aware Intelligence: Uses game-specific knowledge and terminology to improve analysis accuracy.

2. Context-Aware Commentary

- Generates commentary based on evolving match context rather than isolated frames.
- Prioritizes meaningful gameplay developments.
- Uses evidence-aware generation to reduce unsupported claims.
- Prevents repetitive commentary through event prioritization and deduplication.
- Preserves timestamps for synchronization with the original gameplay.
- Supports incremental script generation through the streaming pipeline.

3. AI Voice Generation

- Optional text-to-speech integration.
- Google Gemini TTS integration.
- Generates spoken commentary from eligible script segments.
- Supports audio review and synchronized playback.
- Keeps voice generation independent of the vision provider configuration.

4. Desktop Commentary Workspace

ROB provides a dedicated desktop workspace built around the gameplay video and its generated commentary.

- Project-based workflow.
- Gameplay video preview.
- Processing status and diagnostics.
- Script and commentary review.
- Synchronized audio timeline.
- Per-segment audio playback.
- Export workflow with progress and cancellation.

5. Video Export

- Combines gameplay footage with generated commentary audio.
- Preserves the original game's audio.
- Uses FFmpeg for media processing.
- Exports the final result as an MP4 video.

6. Flexible AI Provider Configuration

ROB supports configurable AI providers instead of locking users into a single model.

Vision providers:

- Meta
- Baseten
- Custom OpenAI-compatible API endpoints

Voice provider:

- Google Gemini TTS

Provider configuration includes credential management, model selection, connection testing, and image-analysis verification.

---

Architecture

ROB follows a local-first desktop architecture.

The Electron application handles the interface, project management, configuration, and media workflow. A local Python worker handles gameplay analysis and the AI commentary pipeline.

```text
┌──────────────────────────┐
│       ROB Desktop       │
│                          │
│     Electron + React     │
│                          │
│  Projects & Configuration│
│  Gameplay Preview        │
│  Commentary Editor      │
│  Audio Timeline         │
│  Video Export           │
└────────────┬─────────────┘
│
Secure IPC Bridge
│
┌────────────▼─────────────┐
│     Python Worker       │
│                          │
│   Adaptive Sampling     │
│          ↓               │
│   Vision Analysis       │
│          ↓               │
│   Structured Observations│
│          ↓               │
│   Match-State Tracking  │
│          ↓               │
│   Event Detection       │
│          ↓               │
│   Commentary Generation │
│          ↓               │
│   Text-to-Speech        │
└────────────┬─────────────┘
│
Provider APIs
│
Vision Models / TTS Models
```

Processing Pipeline

1. Gameplay footage is loaded into a project.
2. The vision engine samples frames according to its adaptive sampling strategy.
3. Frames are analyzed using the configured vision provider.
4. Structured observations are validated and persisted.
5. The match-state tracker updates the contextual understanding of the game.
6. Event detection identifies meaningful developments.
7. The commentary engine generates timestamped script segments.
8. Optional TTS generates corresponding audio.
9. The editor synchronizes the script, audio, and gameplay timeline.
10. FFmpeg combines the source video and commentary audio during export.

---

Technology Stack

Component| Technology
Desktop Framework| Electron 36
Frontend| React 19
Build Tool| Vite
Styling| Tailwind CSS 4
UI Components| Radix UI
Animations| Motion
Notifications| Sonner
Icons| Lucide
Processing Engine| Python 3.12+
Computer Vision| OpenCV
AI Integration| OpenAI-compatible API, Google Gen AI SDK
Vision Providers| Meta, Baseten, Custom API
Voice Generation| Google Gemini TTS
Media Processing| FFmpeg
Communication| Electron IPC, Preload Bridge, NDJSON

---

Supported Games

ROB uses game-specific prompt packs and terminology to improve gameplay understanding and commentary quality.

Current built-in prompt packs include:

- Free Fire
- BGMI
- Call of Duty

The architecture also supports custom prompt-pack overlays and configurable commentary presets.

---

Getting Started

Prerequisites

Before installing ROB, make sure you have:

- Git
- Node.js 20 or newer
- npm
- Python 3.12 or newer
- A supported desktop environment

AI provider credentials are required for live model inference and voice generation. These services may incur usage charges.

1. Clone the Repository

```bash
git clone https://github.com/ishan-codes-code/ROB-Studios.git

cd ROB-Studios
```

2. Set Up Python Environment

Create a virtual environment:

```bash
python3 -m venv .venv
```

Activate it:

Linux / macOS

```bash
source .venv/bin/activate
```

Windows PowerShell

```powershell
.venv\Scripts\Activate.ps1
```

Install dependencies:

```bash
python -m pip install --upgrade pip

pip install -r requirements.txt
```

3. Install Electron Dependencies

```bash
cd electron

npm install
```

4. Launch ROB

```bash
npm start
```

The Electron application launches the desktop interface and manages the local Python worker when processing is started.

---

Configuration

ROB provides an in-app configuration workflow for connecting AI providers.

Vision Configuration

1. Open provider configuration.
2. Select a supported vision provider.
3. Enter the required API credentials.
4. Select or configure the model.
5. Test the connection.
6. Verify image-analysis functionality.

Custom Providers

ROB supports configurable OpenAI-compatible vision endpoints.

Users can provide:

- API endpoint URL.
- API key.
- Model identifier.

Model discovery is supported when the configured endpoint exposes a compatible models endpoint. Manual model entry is also available.

Voice Configuration

Voice generation is optional.

Configure Google Gemini TTS separately when spoken commentary is required.

Important: Keep API credentials private. Never commit real API keys or secrets to the repository. External provider usage may incur charges.

---

Development

Electron Commands

Run these commands inside the "electron/" directory.

Command| Description
"npm start"| Launch ROB
"npm test"| Run Electron tests
"npm run package"| Package the application
"npm run make"| Build distributable targets

Python Commands

Run these commands from the repository root with the virtual environment activated.

Display CLI options:

```bash
python python/main.py --help
```

Run the worker directly:

```bash
python python/worker.py /path/to/gameplay.mp4 --output-dir /tmp/rob-run
```

Run Python tests:

```bash
python -m unittest discover -s tests -v
```

The Python worker communicates with Electron through newline-delimited JSON messages. Standard output is reserved for protocol messages, while diagnostic output is written to standard error.

---

Project Structure

```text
ROB-Studios/
│
├── electron/
│   ├── src/
│   │   ├── main/
│   │   ├── main.js
│   │   ├── preload.js
│   │   └── ...
│   │
│   ├── test/
│   └── package.json
│
├── python/
│   ├── ai_commentator/
│   │   ├── vision/
│   │   ├── state/
│   │   ├── events/
│   │   ├── commentary/
│   │   ├── script/
│   │   ├── streaming/
│   │   ├── tts/
│   │   └── prompts/
│   │
│   ├── main.py
│   ├── worker.py
│   ├── provider_setup.py
│   └── tts_provider_setup.py
│
├── docs/
│   ├── architecture.md
│   ├── current-state.md
│   ├── roadmap.md
│   ├── contracts/
│   └── decisions/
│
├── tests/
│
├── requirements.txt
└── README.md
```

---

Testing

ROB includes automated tests for its Python processing engine and Electron application.

The test suites are designed to validate application behavior without requiring live AI provider calls wherever possible.

Run Python tests:

```bash
python -m unittest discover -s tests -v
```

Run Electron tests:

```bash
cd electron

npm test
```

Build the desktop application:

```bash
npm run package
```

Live provider connectivity, model availability, and end-to-end audio quality should be verified separately using configured provider credentials.

---

Security & Privacy

- API credentials should never be committed to version control.
- Use the in-app provider configuration for desktop workflows.
- Only configure trusted external API endpoints.
- Review the privacy, data-retention, and billing policies of external providers.
- Gameplay sent to external AI providers is subject to their respective data-handling policies.

---

Project Status

ROB is actively under development.

The repository includes the Electron desktop application, local Python processing engine, vision integrations, adaptive sampling, match-state tracking, evidence-aware event detection, streaming commentary pipeline, TTS integration, synchronized editor timeline, and video export workflow.

Some capabilities depend on external provider availability, credentials, quotas, and operating-system compatibility.

For implementation details, see:

- "Architecture" (docs/architecture.md)
- "Current State" (docs/current-state.md)
- "Roadmap" (docs/roadmap.md)

---

Contributing

Contributions, bug reports, and feature suggestions are welcome.

1. Check existing issues before creating a new one.
2. Discuss significant changes before implementation.
3. Keep automated tests deterministic and offline wherever possible.
4. Never commit API keys, private gameplay, or generated credentials.
5. Update relevant documentation when changing application behavior.

"Report an Issue" (https://github.com/ishan-codes-code/ROB-Studios/issues)

---

License

No repository-level license file was identified at the time of writing.

Until a license is added, all rights remain reserved by the copyright holder. Do not assume unrestricted permission to redistribute or reuse the project.

---

<p align="center">
  **ROB — Real-time Observer & Broadcaster**
  <br />
  Making esports commentary intelligent.
</p>
