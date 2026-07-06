"""Unit tests for VO2 max categorization (Cooper Institute norms)."""
from datetime import date

from app import vo2max


def test_age_on_handles_birthday_not_yet_reached():
    bd = date(1970, 9, 20)
    assert vo2max.age_on(bd, on=date(2026, 9, 19)) == 55
    assert vo2max.age_on(bd, on=date(2026, 9, 20)) == 56
    assert vo2max.age_on(bd, on=date(2026, 1, 1)) == 55


def test_classify_55yo_male_good_band():
    # 50-59 male: Good is 35.8-40.9; 38.8 lands in Good, next is Excellent at 41.0.
    r = vo2max.classify(38.8, 55, "male")
    assert r is not None
    assert r["category"] == "Good"
    assert r["category_index"] == 3
    assert r["range_low"] == 35.8
    assert r["range_high"] == 41.0
    assert r["next_category"] == "Excellent"
    assert r["next_at"] == 41.0
    assert r["age"] == 55
    assert r["sex"] == "male"


def test_classify_superior_has_no_next_tier():
    r = vo2max.classify(60.0, 55, "M")
    assert r is not None
    assert r["category"] == "Superior"
    assert r["range_high"] is None
    assert r["next_category"] is None
    assert r["next_at"] is None


def test_classify_very_poor_has_no_lower_bound():
    r = vo2max.classify(10.0, 55, "male")
    assert r is not None
    assert r["category"] == "Very Poor"
    assert r["range_low"] is None
    assert r["next_category"] == "Poor"


def test_classify_female_uses_female_table():
    # 50-59 female: Good is 27.0-31.4; the same value is a different band by sex.
    r = vo2max.classify(29.0, 55, "female")
    assert r is not None
    assert r["category"] == "Good"


def test_classify_unknown_sex_returns_none():
    assert vo2max.classify(40.0, 55, "") is None
    assert vo2max.classify(40.0, 55, "other") is None
