# Deploying gpu-service to Hyperstack

Same image as everywhere else (`gpu-service/Dockerfile`) — Hyperstack just
provisions a CUDA-capable VM/container and runs it. There is no
Hyperstack-specific code, only this doc and (optionally) the
`docker-compose.gpu.yml` below for their VM-based deployment flow.

## VM-based deployment (Hyperstack GPU VM)

1. Provision a GPU VM in the Hyperstack console (an NVIDIA A100/A6000/RTX
   4090-class instance; see docs/ARCHITECTURE.md for the VRAM budget behind
   that choice — 16GB+ is the practical floor for Whisper large-v3 + NLLB
   + a couple of concurrent TTS models).
2. Install Docker + the NVIDIA Container Toolkit on the VM (standard Ubuntu
   steps — Hyperstack images typically ship with NVIDIA drivers pre-installed;
   confirm with `nvidia-smi`).
3. From your machine, sync the repo (or `git clone` if you push this to a
   remote) and build on the VM:
   ```bash
   docker build -f gpu-service/Dockerfile -t ttsopensource-gpu-service .
   ```
4. Run it:
   ```bash
   docker compose -f deploy/hyperstack/docker-compose.gpu.yml up -d
   ```
5. Point the orchestrator (wherever it runs — can be a cheap CPU-only box)
   at `GPU_SERVICE_URL=http://<hyperstack-vm-ip>:8000`.

## Container-based deployment (Hyperstack Kubernetes / managed containers)

If your Hyperstack plan offers managed container/Kubernetes hosting instead
of raw VMs, push the built image to a registry Hyperstack can pull from and
deploy it as an ordinary GPU-scheduled container with port 8000 exposed —
same env vars as the VM path (see gpu-service/.env.example), plus
`GPU_PROVIDER=hyperstack` for the `/health` field.

## Notes

- Hyperstack bills per-GPU-hour on VMs; stop the VM (or scale the deployment
  to zero) when no live stream is running rather than relying on
  `MODEL_IDLE_UNLOAD_SECONDS` for cost control — that setting only frees VRAM
  on an already-running instance.
- Networking: expose port 8000 to wherever the orchestrator runs, and set
  `GPU_SERVICE_API_KEY` — Hyperstack VMs get a public IP by default, so don't
  run without the API key unless it's firewalled to the orchestrator's IP only.
