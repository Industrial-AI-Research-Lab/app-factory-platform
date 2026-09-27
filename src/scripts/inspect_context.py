import asyncio
import os
from storage.mongo_backend import MongoStorageBackend


async def main():
    storage = MongoStorageBackend(
        connection_string=os.getenv("MONGODB_URI", "mongodb://localhost:27017"),
        database=os.getenv("MONGODB_DATABASE", "AppFactory"),
        enable_transactions=False,
    )
    await storage.initialize()
    try:
        # Get most recent project
        page = await storage.list_projects(limit=1)
        projects = page["projects"]
        if not projects:
            print('No projects in database')
            return
        project = projects[0]
        project_id = project.get('project_id')
        print(f'Most recent project: {project_id}')

        # Load context
        context_data = await storage.load_context(project_id)
        if not context_data:
            print('No context found for project')
            return

        print('\n=== ARTIFACTS IN CONTEXT ===')
        artifacts = context_data.get('artifacts', [])
        print(f'Total artifacts: {len(artifacts)}')

        for i, artifact in enumerate(artifacts, 1):
            print(f'\n--- Artifact {i} ---')
            print(f'Type: {artifact.get("type")}')
            print(f'Path: {artifact.get("path")}')
            print(f'Has content key: {"content" in artifact}')
            if "content" in artifact:
                content = artifact.get("content", "")
                print(f'Content length: {len(content)} chars')
                print(f'Content preview: {content[:100]}...' if len(content) > 100 else f'Content: {content}')
            print(f'Metadata: {artifact.get("metadata")}')

        print('\n=== PLAN ===')
        plan = context_data.get('plan', {})
        tasks = plan.get('tasks', [])
        print(f'Total tasks: {len(tasks)}')
        for i, task in enumerate(tasks, 1):
            print(f'{i}. {task.get("description", "No description")[:80]}')
    finally:
        await storage.close()


if __name__ == '__main__':
    asyncio.run(main())
