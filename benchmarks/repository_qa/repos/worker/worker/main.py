from .runner import run_job


def main(database, queue):
    for records in queue:
        run_job(database, records)
