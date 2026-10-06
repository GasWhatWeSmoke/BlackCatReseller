"""Small, non-sensitive UI progress events; never control marketplace actions."""
import json


def progress(stage, photo_count=None):
    try:
        data = {'stage': stage}
        if photo_count is not None:
            data['photoCount'] = photo_count
        print('BLACKCAT_PROGRESS ' + json.dumps(data), flush=True)
    except Exception:
        pass  # A closed progress stream must not interrupt a marketplace action.
