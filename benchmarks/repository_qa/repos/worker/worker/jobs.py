from .storage import save_export


def process_export(database, records):
    """Persist the number of records accepted for an export."""
    if not records:
        raise ValueError("no records")
    return save_export(database, len(records))
