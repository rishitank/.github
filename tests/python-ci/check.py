"""Fixture for reusable-selftest.yml: clean under ruff and mypy, exits 0.

python-ci.yml lints and typechecks this directory strictly, then runs this
file as its verify command, so every step of the job runs on each change.
"""


def add(a: int, b: int) -> int:
    return a + b


if __name__ == "__main__":
    assert add(2, 3) == 5
    print("ok")
