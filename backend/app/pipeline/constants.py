"""Statutory text and thresholds shared by the matcher and sample labels."""

# TTB mandatory health warning, word for word.
# The header "GOVERNMENT WARNING:" is checked separately for all-caps.
GOVERNMENT_WARNING_BODY = (
    "(1) According to the Surgeon General, women should not drink alcoholic "
    "beverages during pregnancy because of the risk of birth defects. "
    "(2) Consumption of alcoholic beverages impairs your ability to drive a "
    "car or operate machinery, and may cause health problems."
)

# Sarah Chen: agents abandoned a pilot that took longer than reading by eye.
LATENCY_BUDGET_MS = 5000

# Janet / Seattle peak season. Larger dumps are split, not silently truncated.
MAX_BATCH_FILES = 300
MAX_FILE_BYTES = 8 * 1024 * 1024

# Below this, a field is not auto-passed or auto-failed. A person compares it.
LOW_FIELD_CONFIDENCE = 60

# A photo this weak is unreadable. We ask for another picture instead of guessing.
UNREADABLE_CONFIDENCE = 45
UNREADABLE_MIN_ALNUM = 12

# Brand similarity after normalization. Dave Morrison's all-caps brand is handled
# on its own, before these bands, so it stays a judgment call.
FUZZY_MATCH = 95
FUZZY_REVIEW = 80

# Alcohol must agree within a tenth of a percent. A full point is a mismatch.
ABV_MATCH_TOLERANCE = 0.1
ABV_REVIEW_TOLERANCE = 0.5

# Warning text a few characters off is treated as a possible scanner miss.
WARNING_OCR_DISTANCE = 3

# Buried warning type. Normal labels use a smaller warning than the brand;
# only extreme shrinkage is flagged.
TINY_WARNING_PX = 14
TINY_WARNING_RATIO = 0.22

IMAGE_TTL_SECONDS = 2 * 60 * 60
OCR_WORKERS = 4
