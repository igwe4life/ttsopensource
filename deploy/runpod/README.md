# Deploying gpu-service to RunPod

RunPod runs the exact same image as everywhere else (`gpu-service/Dockerfile`)
— nothing in the application code branches on "RunPod". Only environment
variables and networking differ.

## Option A — RunPod Pods (persistent, simplest)

1. Build and push the image:
   ```bash
   docker build -f gpu-service/Dockerfile -t <your-registry>/ttsopensource-gpu-service:latest .
   docker push <your-registry>/ttsopensource-gpu-service:latest
   ```
2. RunPod console -> Pods -> Deploy -> Custom Container.
   - Image: `<your-registry>/ttsopensource-gpu-service:latest`
   - GPU: any CUDA 12.1-compatible GPU (16GB+ VRAM recommended for
     Whisper large-v3 + NLLB-600M + a couple of TTS models loaded at once —
     see docs/ARCHITECTURE.md's VRAM budget table).
   - Expose HTTP port `8000`.
   - Env vars: at minimum `GPU_SERVICE_API_KEY` (pick a secret), `DEVICE=cuda`,
     `GPU_PROVIDER=runpod`.
   - Volume: mount a persistent volume at `/srv/models` and set
     `PIPER_VOICES_DIR=/srv/models/piper` so downloaded Piper voices survive
     pod restarts (HuggingFace-cached models — Whisper/NLLB/MMS/XTTS — persist
     under `/root/.cache/huggingface` if you also mount that path).
3. Point the orchestrator at it: `GPU_SERVICE_URL=https://<pod-id>-8000.proxy.runpod.net`.

## Option B — RunPod Serverless (scale-to-zero, pay per request)

RunPod Serverless expects a `handler(event)` function rather than a long-running
HTTP server. `handler.py` in this directory adapts the FastAPI app's `/process`
route to that contract without duplicating logic — it imports
`app.pipeline.process_pipeline.process_segment` directly.

```bash
docker build -f deploy/runpod/Dockerfile.serverless -t <your-registry>/ttsopensource-gpu-serverless:latest .
docker push <your-registry>/ttsopensource-gpu-serverless:latest
```

Then create a Serverless endpoint from that image in the RunPod console.
Cold starts are slower here (model load happens on first invocation and
serverless workers can be evicted between requests) — Option A is better for
a genuinely continuous live stream; Serverless suits bursty/occasional use.

## Notes

- RunPod bills per-GPU-second; `MODEL_IDLE_UNLOAD_SECONDS` (gpu-service config)
  doesn't reduce RunPod cost on a Pod (you pay for the pod either way) — it
  only matters for VRAM headroom on that pod. For cost control, use Serverless
  or scale Pods down manually when no stream is active.
- Nothing here is RunPod-specific beyond this doc and `handler.py` — see
  deploy/hyperstack/README.md for the equivalent on a different provider.
