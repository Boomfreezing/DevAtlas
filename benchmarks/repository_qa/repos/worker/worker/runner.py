from .jobs import process_export
from .settings import MAX_RETRIES


def run_job(database, records):
    for attempt in range(MAX_RETRIES):
        try:
            return process_export(database, records)
        except ValueError:
            if attempt == MAX_RETRIES - 1:
                raise
