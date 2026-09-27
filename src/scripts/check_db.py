import asyncio
import os
from urllib.parse import urlparse

from storage.mongo_backend import MongoStorageBackend


def _mongo_host_summary(uri: str) -> str:
    """Host:port for logs only (no user/password)."""
    try:
        u = urlparse(uri)
        host = u.hostname or "?"
        port = u.port or 27017
        return f"{host}:{port}"
    except Exception:
        return "?"


async def main():
    try:
        from dotenv import load_dotenv

        load_dotenv()
        load_dotenv(
            dotenv_path=os.path.join(os.path.dirname(__file__), os.pardir, ".env"),
        )
    except ImportError:
        pass

    uri = os.getenv("MONGODB_URI", "mongodb://localhost:27017")
    dbname = os.getenv("MONGODB_DATABASE", "AppFactory")
    print(
        f"[check_db] MONGODB_URI host: {_mongo_host_summary(uri)} | "
        f"MONGODB_DATABASE={dbname}"
    )
    if "localhost" in uri or "127.0.0.1" in uri:
        print(
            "[check_db] Подсказка: для dev-кластера задайте MONGODB_URI и "
            "MONGODB_DATABASE в src/.env (часто имя БД `synaps`, см. .env.example)."
        )

    storage = MongoStorageBackend(
        connection_string=uri,
        database=dbname,
        enable_transactions=False,
    )
    try:
        await storage.initialize()
    except Exception as e:
        print(f"[check_db] Ошибка подключения: {type(e).__name__}: {e}")
        print(
            "[check_db] Скопируйте строку подключения в MONGODB_URI (как в Cursor MCP), "
            "не коммитьте .env."
        )
        raise SystemExit(1) from e
    try:
        # Tool configurations: legacy allowed_agents (should trend to 0 after re-saves / seed)
        tc = storage.tool_configurations
        tool_total = await tc.count_documents({})
        legacy_agents = await tc.count_documents({"allowed_agents": {"$exists": True}})
        print(f"\n[TOOL_CONFIG] total documents: {tool_total}")
        print(f"[TOOL_CONFIG] documents with key 'allowed_agents': {legacy_agents}")
        if legacy_agents:
            cur = tc.find({"allowed_agents": {"$exists": True}}, {"_id": 1, "name": 1, "tenant_id": 1}).limit(20)
            rows = await cur.to_list(length=20)
            print("[TOOL_CONFIG] sample (up to 20):")
            for doc in rows:
                print(f"  _id={doc.get('_id')!r} name={doc.get('name')!r} tenant_id={doc.get('tenant_id')!r}")

        # Artifacts count
        artifact_count = await storage.artifacts.count_documents({})
        print(f"Total artifacts in database: {artifact_count}")

        # Recent artifacts (limit 10)
        if artifact_count > 0:
            cursor = storage.artifacts.find().sort("created_at", -1).limit(10)
            rows = await cursor.to_list(length=10)
            print("\nRecent artifacts:")
            for doc in rows:
                aid = str(doc.get("_id"))
                atype = doc.get("artifact_type")
                path = doc.get("path")
                clen = len(doc.get("content", "") or "")
                created = doc.get("created_at")
                print(f"  ID: {aid}, Type: {atype}, Path: {path}, Content Length: {clen}, Created: {created}")

        # Recent projects (limit 5)
        rows = await storage.projects.find().sort("created_at", -1).limit(5).to_list(length=5)
        print("\n\nRecent projects:")
        for doc in rows:
            pid = doc.get("project_id", "")
            up = doc.get("user_prompt", "")
            status = doc.get("status", "")
            prompt_preview = (up[:60] + "...") if len(up) > 60 else up
            print(f'  {pid[:8]}... - "{prompt_preview}" - Status: {status}')
    finally:
        await storage.close()


if __name__ == "__main__":
    asyncio.run(main())
