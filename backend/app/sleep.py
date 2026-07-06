"""Sleep quality rating derived from nightly asleep hours.

Apple Health has no native "sleep score" — it records hours (and stages), so we
compute a simple, transparent rating by comparing last night's asleep hours to
the adult recommendation of 7-9 hours. Both under- and over-sleeping degrade the
rating symmetrically. The tiers are intentionally coarse (four bands) so the
dashboard reads at a glance.
"""

# 0=Low .. 3=Excellent (index used to pick a color on the frontend).
CATEGORIES = ("Low", "Fair", "Good", "Excellent")

# Adult target band (National Sleep Foundation: 7-9 h for ages 18-64).
TARGET_LOW = 7.0
TARGET_HIGH = 9.0


def classify(hours: float | None) -> dict | None:
    """Rate a night's asleep hours against the 7-9 h target.

    Returns ``None`` when ``hours`` is missing so callers can omit the band
    rather than show a misleading rating.
    """
    if hours is None or hours < 0:
        return None
    if TARGET_LOW <= hours <= TARGET_HIGH:
        category = "Excellent"
    elif 6.0 <= hours < TARGET_LOW or TARGET_HIGH < hours <= 10.0:
        category = "Good"
    elif 5.0 <= hours < 6.0 or 10.0 < hours <= 11.0:
        category = "Fair"
    else:
        category = "Low"
    return {
        "category": category,
        "category_index": CATEGORIES.index(category),
        "target_low": TARGET_LOW,
        "target_high": TARGET_HIGH,
    }
