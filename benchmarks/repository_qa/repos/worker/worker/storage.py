def save_export(database, record_count):
    return database.execute(
        "INSERT INTO export_jobs(record_count) VALUES (:count)",
        {"count": record_count},
    )
