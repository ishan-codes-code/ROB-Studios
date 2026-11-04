"""Dispatch packaged desktop operations to the existing Python entry points."""

import sys

import provider_setup
import prompt_packs
import tts_catalog
import tts_say
import worker


def main(argv=None):
    arguments = list(sys.argv[1:] if argv is None else argv)
    if not arguments:
        print("Expected a desktop runtime operation.", file=sys.stderr)
        return 2

    operation, *operation_args = arguments
    if operation == "worker":
        return worker.main(operation_args)
    if operation == "provider-setup":
        sys.argv = ["provider_setup.py", *operation_args]
        return provider_setup.main()
    if operation == "prompt-packs":
        return prompt_packs.main()
    if operation == "tts-catalog":
        return tts_catalog.main()
    if operation == "tts-say":
        return tts_say.main(operation_args)

    print("Unsupported desktop runtime operation.", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())