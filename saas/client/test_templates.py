"""Offline checks using Python 3.11+ standard JSON/TOML parsers."""
import json
import pathlib
import tomllib
import unittest

ROOT = pathlib.Path(__file__).parent
SERVER = "allenlabs-memory"
ENDPOINT = "https://memory.allenlabs.org/mcp"
SSO_SCOPES = ["openid", "profile", "email", "memory:read", "memory:write", "memory:delete"]


class ConnectionTemplates(unittest.TestCase):
    def test_codex_uses_environment_reference_or_oauth(self):
        for mode in ("pat", "sso"):
            with (ROOT / f"codex.{mode}.toml").open("rb") as source:
                config = tomllib.load(source)
            self.assertEqual(set(config), {"mcp_servers"})
            self.assertEqual(set(config["mcp_servers"]), {SERVER})
            expected = {"url": ENDPOINT}
            if mode == "pat":
                expected["bearer_token_env_var"] = "MEMORY_SAAS_PAT"
            else:
                expected["scopes"] = SSO_SCOPES
            self.assertEqual(config["mcp_servers"][SERVER], expected)

    def test_claude_and_plugin_http_configs_do_not_embed_credentials(self):
        for mode in ("pat", "sso"):
            config = json.loads((ROOT / f"claude.{mode}.json").read_text("utf-8"))
            expected = {"type": "http", "url": ENDPOINT}
            if mode == "pat":
                expected["headers"] = {"Authorization": "Bearer ${MEMORY_SAAS_PAT}"}
            else:
                expected["oauth"] = {"scopes": " ".join(SSO_SCOPES)}
            self.assertEqual(config, {"mcpServers": {SERVER: expected}})

    def test_pat_examples_require_explicit_space_selection(self):
        for kind in ("personal", "organization"):
            value = json.loads((ROOT / f"pat-request.{kind}.json").read_text("utf-8"))
            self.assertEqual(value["capabilities"], ["read", "create", "update"])
            self.assertEqual(len(value["spaceIds"]), 1)
            self.assertTrue(value["spaceIds"][0].startswith("REPLACE_WITH_"))
            self.assertTrue(1 <= value["expiresInDays"] <= 90)
            self.assertEqual("organizationId" in value, kind == "organization")
            self.assertFalse({"token", "clientSecret", "headers"} & value.keys())


if __name__ == "__main__":
    unittest.main()
