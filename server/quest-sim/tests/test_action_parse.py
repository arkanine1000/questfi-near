import pytest

from quest_sim.engine.action_parse import parse_action_string


def test_bare_verb():
    assert parse_action_string("search") == {"action": "search"}


def test_single_kwarg():
    assert parse_action_string("move:direction=N") == {"action": "move", "direction": "N"}


def test_multiple_kwargs():
    assert parse_action_string("attack:target=goblin_1:style=reckless") == {
        "action": "attack",
        "target": "goblin_1",
        "style": "reckless",
    }


def test_action_prefix_is_stripped():
    assert parse_action_string("ACTION:move:direction=S") == {"action": "move", "direction": "S"}


def test_surrounding_whitespace_is_tolerated():
    assert parse_action_string("  move : direction = N  ") == {"action": "move", "direction": "N"}


@pytest.mark.parametrize("bad", ["", "   ", ":direction=N"])
def test_empty_action_raises(bad):
    with pytest.raises(ValueError):
        parse_action_string(bad)
