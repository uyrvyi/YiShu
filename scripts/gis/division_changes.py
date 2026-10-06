"""Verify dated primary evidence before applying explicitly transcribed additions."""

import hashlib
from html.parser import HTMLParser
from pathlib import Path


def text_content(html):
    class Text(HTMLParser):
        def __init__(self):
            super().__init__()
            self.parts = []

        def handle_data(self, text):
            self.parts.append(text)

    parser = Text()
    parser.feed(html)
    return "".join(parser.parts)


def evidence_file(directory, name, digest):
    if Path(name).name != name:
        raise ValueError("evidence_path_invalid")
    content = (directory / name).read_bytes()
    if hashlib.sha256(content).hexdigest() != digest:
        raise ValueError("official_patch_integrity_failed:" + name)
    return content


def apply_division_changes(official, manifest, directory):
    if manifest.get("version") != 1 or manifest.get("nationalChangesComplete") is not False:
        raise ValueError("division_patch_scope_invalid")
    html = evidence_file(directory, manifest["codeTableFile"], manifest["codeTableSha256"]).decode()
    if "2026年6月30日" not in html:
        raise ValueError("official_patch_date_failed")
    updated, evidence, seen = dict(official), {}, set()
    for addition in manifest["additions"]:
        code, name = addition["code"], addition["name"]
        if code in updated or code in seen or len(code) != 6 or not code.isdigit() or \
           not code.startswith(addition["provinceCode"]) or not code.startswith(addition["cityCode"]):
            raise ValueError("official_patch_identity_failed")
        transcription = addition["manualTranscription"]
        if transcription["countyCode"] != code or transcription["countyName"] != name:
            raise ValueError("official_patch_transcription_failed")
        announcement = text_content(evidence_file(directory, addition["announcementFile"], addition["announcementSha256"]).decode())
        if not all(text in announcement for text in addition["requiredAnnouncementText"]):
            raise ValueError("official_patch_announcement_failed:" + code)
        evidence_file(directory, addition["codePageFile"], addition["codePageSha256"])
        if addition["codePageUrl"].split("/202607/")[1] not in html:
            raise ValueError("official_patch_page_not_in_table")
        updated[code] = name
        evidence[code] = addition
        seen.add(code)
    return updated, evidence
