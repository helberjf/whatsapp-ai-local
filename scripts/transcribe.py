"""Executa Whisper local sem enviar o áudio para qualquer serviço externo.

Motores: openai-whisper (padrão) ou faster-whisper (mais rápido na CPU, int8). Nenhum modelo é baixado aqui:
o modelo precisa estar instalado antes (veja o README).
"""
import argparse
import json
import os
import sys
from pathlib import Path


def threads():
    return min(4, max(1, (os.cpu_count() or 2) // 2))


def with_whisper(args):
    try:
        import torch
        import whisper
    except ImportError:
        return {"error": "missing_whisper"}
    torch.set_num_threads(threads())
    cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "whisper"
    model_file = cache / (args.model + ".pt")
    if not model_file.is_file():
        return {"error": "missing_model"}
    model = whisper.load_model(str(model_file), device="cpu")
    transcript = model.transcribe(args.audio, language=None if args.language == "auto" else args.language,
                                  fp16=False, verbose=None, temperature=0, condition_on_previous_text=False)
    return {"text": transcript.get("text", "").strip()}


def with_faster_whisper(args):
    try:
        from faster_whisper import WhisperModel
    except ImportError:
        return {"error": "missing_faster_whisper"}
    try:
        model = WhisperModel(args.model, device="cpu", compute_type="int8", cpu_threads=threads(), local_files_only=True)
    except Exception:
        return {"error": "missing_model"}
    segments, _ = model.transcribe(args.audio, language=None if args.language == "auto" else args.language,
                                   beam_size=1, temperature=0, condition_on_previous_text=False, vad_filter=True)
    return {"text": " ".join(segment.text.strip() for segment in segments).strip()}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", choices=["tiny", "base", "small", "medium", "large-v3"], required=True)
    parser.add_argument("--language", choices=["pt", "auto", "en", "es"], default="pt")
    parser.add_argument("--engine", choices=["whisper", "faster-whisper"], default="whisper")
    args = parser.parse_args()
    try:
        result = with_faster_whisper(args) if args.engine == "faster-whisper" else with_whisper(args)
    except Exception:
        result = {"error": "transcription_failed"}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main())
