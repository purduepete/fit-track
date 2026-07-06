"""Unit tests for sleep quality rating (asleep hours vs a 7-9 h target)."""
from app import sleep


def test_classify_excellent_within_target():
    for h in (7.0, 8.0, 9.0):
        band = sleep.classify(h)
        assert band is not None
        assert band["category"] == "Excellent"
        assert band["category_index"] == 3
        assert (band["target_low"], band["target_high"]) == (7.0, 9.0)


def test_classify_good_just_outside_target():
    assert sleep.classify(6.5)["category"] == "Good"
    assert sleep.classify(9.5)["category"] == "Good"


def test_classify_fair_and_low():
    assert sleep.classify(5.5)["category"] == "Fair"
    assert sleep.classify(10.5)["category"] == "Fair"
    assert sleep.classify(4.0)["category"] == "Low"
    assert sleep.classify(12.0)["category"] == "Low"


def test_classify_missing_returns_none():
    assert sleep.classify(None) is None
    assert sleep.classify(-1.0) is None
