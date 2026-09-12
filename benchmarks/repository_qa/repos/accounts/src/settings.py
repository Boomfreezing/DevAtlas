import os

# Seconds before an inactive session expires.
SESSION_TTL = int(os.getenv("SESSION_TTL", "1800"))
