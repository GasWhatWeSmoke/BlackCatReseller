# System requirements

Black Cat Reseller is a local Windows desktop application. Its inventory, photos,
browser workers, and optional AI runtime run on your computer.

## Without local AI

- Windows 10 or 11, 64-bit.
- A four-core CPU and at least 8 GB RAM; an SSD and 16 GB RAM are preferable.
- Chrome and a connected second monitor for marketplace browser automation.
- Your own accounts on the marketplaces you use.
- Internet access for initial setup and marketplace activity.
- Enough free disk space for original photos, processed copies, exports, and backups.

A dedicated GPU is not required for manual entry and the regular inventory workflow.
Photo storage grows with your inventory and image sizes. Keep an independent backup
of your original photos and monitor available disk space.

## Optional local AI

The pinned local vision profile targets an NVIDIA GPU with at least 8 GB VRAM,
16 GB system RAM, and additional disk space for model/runtime downloads. Clothing
label OCR runs on the CPU. Use manual entry when the local AI profile is unavailable
or has not passed its setup checks. Treat generated suggestions as reviewable drafts.

## Development

Node.js 24, npm, and Git are required when running from source. Worker setup provides
portable Python and the Python dependencies. Installer users do not need to set up a
separate development environment. The optional AI setup downloads additional tools
and model files; their licenses are separate from this project's MIT license.
