"""
Skill Name: test_upsert_skill
Description: Step 2 Description
Entrypoint: run
Version: 1.1.0
Parameters: {
  "type": "object",
  "properties": {
    "count": {
      "type": "number"
    }
  }
}
"""

import json
import sys

def run(**kwargs): return {"step": 2}
