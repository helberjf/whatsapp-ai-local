"""Executa Whisper local sem enviar o áudio para qualquer serviço externo."""
import argparse
import json
import os
import sys
from pathlib import Path


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--audio", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", choices=["tiny", "base", "small", "medium", "large-v3"], required=True)
    parser.add_argument("--language", choices=["pt", "auto", "en", "es"], default="pt")
    args = parser.parse_args()
    result = {}
    try:
        import torch
        import whisper
        torch.set_num_threads(min(4, max(1, (os.cpu_count() or 2) // 2)))
        cache = Path(os.environ.get("XDG_CACHE_HOME", str(Path.home() / ".cache"))) / "whisper"
        model_file = cache / (args.model + ".pt")
        if not model_file.is_file():
            result = {"error": "missing_model"}
        else:
            model = whisper.load_model(str(model_file), device="cpu")
            transcript = model.transcribe(args.audio, language=None if args.language == "auto" else args.language,
                                          fp16=False, verbose=None, temperature=0, condition_on_previous_text=False)
            result = {"text": transcript.get("text", "").strip()}
    except ImportError:
        result = {"error": "missing_whisper"}
    except Exception:
        result = {"error": "transcription_failed"}
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
    return 1 if "error" in result else 0


if __name__ == "__main__":
    sys.exit(main())
