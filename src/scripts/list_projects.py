"""
List all projects in the database

Usage:
    python list_projects.py
"""

import asyncio
from storage.mongo_backend import MongoStorageBackend
import os


async def list_projects():
    """List all projects with their IDs (MongoDB)"""
    storage = MongoStorageBackend(
        connection_string=os.getenv("MONGODB_URI", "mongodb://localhost:27017"),
        database=os.getenv("MONGODB_DATABASE", "AppFactory"),
        enable_transactions=os.getenv("MONGODB_ENABLE_TRANSACTIONS", "true").lower() == "true"
    )
    await storage.initialize()
    
    projects = []
    offset = 0
    limit = 100
    while True:
        page = await storage.list_projects(limit=limit, offset=offset)
        projects.extend(page["projects"])
        if page["next_offset"] is None:
            break
        offset = page["next_offset"]

    if not projects:
        print("No projects found in database")
        return

    print(f"Found {len(projects)} project(s):\n")

    for project in projects:
        project_id = project.get("project_id")
        up = project.get("user_prompt", "")
        user_prompt = up[:60] + "..." if len(up) > 60 else up
        status = project.get("status")
        created_at = project.get("created_at")
        
        print(f"🆔 ID: {project_id}")
        print(f"   Prompt: {user_prompt}")
        print(f"   Status: {status}")
        print(f"   Created: {created_at}")
        print()


if __name__ == "__main__":
    asyncio.run(list_projects())
