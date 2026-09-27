"""
Artifact configuration - centralized file handling rules.

This module defines what files to include/exclude when snapshotting artifacts.
NO HARDCODING extensions in other files - always import from here.
"""
import os
from pathlib import Path
from typing import Tuple

# =============================================================================
# FILE EXTENSIONS TO INCLUDE
# =============================================================================
# These are the file types we consider "source code" worth preserving.
# Add new extensions here as needed.

SOURCE_CODE_EXTENSIONS: Tuple[str, ...] = (
    # Python
    ".py", ".pyi", ".pyx",
    # JavaScript/TypeScript
    ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
    # Web
    ".html", ".htm", ".css", ".scss", ".sass", ".less",
    # Data/Config
    ".json", ".yaml", ".yml", ".toml", ".ini", ".cfg", ".conf",
    ".xml", ".csv",
    # Documentation
    ".md", ".mdx", ".rst", ".txt",
    # Templates
    ".jinja", ".jinja2", ".j2", ".ejs", ".hbs", ".mustache",
    # Shell
    ".sh", ".bash", ".zsh", ".fish", ".ps1", ".bat", ".cmd",
    # Other languages
    ".go", ".rs", ".rb", ".php", ".java", ".kt", ".scala",
    ".c", ".cpp", ".h", ".hpp", ".cs",
    ".swift", ".m", ".mm",
    ".r", ".R", ".sql",
    ".vue", ".svelte",
    # Config files (no extension but important)
    # These are handled separately in INCLUDE_FILENAMES
)

# Specific filenames to always include (even without extension)
INCLUDE_FILENAMES: Tuple[str, ...] = (
    "Dockerfile",
    "Makefile",
    "Procfile",
    "Gemfile",
    "Rakefile",
    ".gitignore",
    ".dockerignore",
    ".env.example",
    "requirements.txt",
    "package.json",
    "package-lock.json",
    "yarn.lock",
    "pnpm-lock.yaml",
    "Cargo.toml",
    "Cargo.lock",
    "go.mod",
    "go.sum",
    "pyproject.toml",
    "setup.py",
    "setup.cfg",
    "tsconfig.json",
    "vite.config.js",
    "vite.config.ts",
    "webpack.config.js",
    "tailwind.config.js",
    "postcss.config.js",
)

# =============================================================================
# DIRECTORIES TO EXCLUDE
# =============================================================================
# These directories are ALWAYS excluded - they contain generated/vendor code.

EXCLUDE_DIRECTORIES: Tuple[str, ...] = (
    # Version control
    ".git",
    ".svn",
    ".hg",
    # Dependencies
    "node_modules",
    "vendor",
    "bower_components",
    # Python
    "venv",
    ".venv",
    "env",
    #".env",
    "__pycache__",
    ".pytest_cache",
    ".mypy_cache",
    ".ruff_cache",
    "*.egg-info",
    ".eggs",
    "dist",
    "build",
    # IDE
    ".idea",
    ".vscode",
    ".vs",
    # OS
    ".DS_Store",
    "Thumbs.db",
    # Container-use
    ".container-use",
    # Other
    "coverage",
    ".coverage",
    "htmlcov",
    ".tox",
    ".nox",
)

# =============================================================================
# FILE PATTERNS TO EXCLUDE
# =============================================================================
# Files matching these patterns are excluded.

EXCLUDE_PATTERNS: Tuple[str, ...] = (
    "*.pyc",
    "*.pyo",
    "*.so",
    "*.dylib",
    "*.dll",
    "*.exe",
    "*.o",
    "*.a",
    "*.lib",
    "*.class",
    "*.jar",
    "*.war",
    "*.min.js",
    "*.min.css",
    "*.map",
    "*.lock",  # Most lock files (except explicitly included ones)
    ".env",
    ".env.local",
    ".env.*.local",
)

# =============================================================================
# LIMITS
# =============================================================================

MAX_FILE_SIZE_BYTES = 5_000_000  # 5000KB - skip large files
MAX_FILES_WITHOUT_CONFIRMATION = 30  # Ask user if more than this
MAX_FILES_HARD_LIMIT = 200  # Never save more than this


# =============================================================================
# HELPER FUNCTIONS
# =============================================================================

def should_include_file(path: str) -> bool:
    """Check if a file should be included in artifacts."""
    p = Path(path)
    
    # Check excluded directories
    parts = p.parts
    for part in parts:
        if part in EXCLUDE_DIRECTORIES:
            return False
        # Handle patterns like *.egg-info
        for excl in EXCLUDE_DIRECTORIES:
            if "*" in excl and part.endswith(excl.replace("*", "")):
                return False
    
    # Check excluded patterns
    name = p.name
    for pattern in EXCLUDE_PATTERNS:
        if pattern.startswith("*.") and name.endswith(pattern[1:]):
            return False
        if pattern == name:
            return False
    
    # Check if it's an included filename
    if name in INCLUDE_FILENAMES:
        return True
    
    # Check extension
    suffix = p.suffix.lower()
    if suffix in SOURCE_CODE_EXTENSIONS:
        return True
    
    return False


def has_conflict_markers(content: str) -> bool:
    """Check if file content has git merge conflict markers."""
    return "<<<<<<< " in content and "=======" in content


def get_repositories_root() -> str:
    """
    Get the repositories root directory.
    
    Priority:
    1. REPOSITORIES_ROOT env var
    2. OS-specific default
    """
    env_val = os.getenv("REPOSITORIES_ROOT")
    if env_val:
        return env_val
    
    # OS-specific defaults
    if os.name == "nt":  # Windows
        return r"C:\work\repositories"
    else:  # Linux/Mac
        home = os.path.expanduser("~")
        # Check common locations
        candidates = [
            os.path.join(home, "repositories"),
            os.path.join(home, "work", "repositories"),
            "/var/lib/AppFactory/repositories",
            "/opt/AppFactory/repositories",
        ]
        for candidate in candidates:
            if os.path.exists(candidate):
                return candidate
        # Default to ~/repositories
        return os.path.join(home, "repositories")
