"""Minimal S-expression reader for KiCad files.

A node is a list whose first element is its tag (a str); atoms are str (quoted strings
are unquoted, numbers stay strings: callers convert). Helpers find children by tag.
"""

from __future__ import annotations

import re

_TOKEN = re.compile(r'\(|\)|"(?:[^"\\]|\\.)*"|[^\s()"]+')


def parse(text: str) -> list:
    stack: list[list] = [[]]
    for m in _TOKEN.finditer(text):
        tok = m.group(0)
        if tok == "(":
            node: list = []
            stack[-1].append(node)
            stack.append(node)
        elif tok == ")":
            stack.pop()
        elif tok[0] == '"':
            stack[-1].append(_unquote(tok[1:-1]))
        else:
            stack[-1].append(tok)
    if len(stack) != 1 or len(stack[0]) != 1:
        raise ValueError("unbalanced s-expression")
    return stack[0][0]


def _unquote(s: str) -> str:
    if "\\" not in s:
        return s
    return re.sub(r"\\(.)", lambda m: {"n": "\n", "t": "\t"}.get(m.group(1), m.group(1)), s)


def children(node: list, tag: str) -> list[list]:
    return [c for c in node[1:] if isinstance(c, list) and c and c[0] == tag]


def child(node: list, tag: str) -> list | None:
    for c in node[1:]:
        if isinstance(c, list) and c and c[0] == tag:
            return c
    return None


def value(node: list, tag: str, default=None):
    """First atom of the child `tag`, e.g. value(fp, "layer") -> "F.Cu"."""
    c = child(node, tag)
    return c[1] if c is not None and len(c) > 1 else default


def floats(node: list | None, tag: str | None = None) -> list[float]:
    """Numeric atoms of `node` (or of its child `tag`)."""
    if node is not None and tag is not None:
        node = child(node, tag)
    if node is None:
        return []
    out = []
    for a in node[1:]:
        if isinstance(a, str):
            try:
                out.append(float(a))
            except ValueError:
                pass
    return out


def has_atom(node: list, atom: str) -> bool:
    return any(a == atom for a in node[1:] if isinstance(a, str))
