import importlib.metadata
import pathlib
import sys


def check():
    requirements = pathlib.Path(__file__).with_name("requirements-mortal.txt")
    for line in requirements.read_text(encoding="utf-8").splitlines():
        name, expected = line.split("==")
        actual = importlib.metadata.version(name)
        if actual != expected:
            raise RuntimeError(f"{name}: expected {expected}, installed {actual}")
    import torch
    import numpy
    import requests

    torch.zeros(1).numpy()
    print("Python inference ready")


if __name__ == "__main__":
    try:
        check()
    except Exception as error:
        print(str(error))
        sys.exit(1)
