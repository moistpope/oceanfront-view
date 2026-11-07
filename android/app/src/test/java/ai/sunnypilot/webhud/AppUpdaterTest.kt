package ai.sunnypilot.webhud

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** The update check's pure parts: reading GitHub's release and comparing versions. */
class AppUpdaterTest {
    @Test
    fun versionsCompareByTheirNumbers() {
        assertEquals(0, AppUpdater.compareVersions("1.0", "1.0"))
        assertEquals(0, AppUpdater.compareVersions("1", "1.0"))
        assertTrue(AppUpdater.compareVersions("1.1", "1.0") > 0)
        assertTrue(AppUpdater.compareVersions("1.10", "1.9") > 0)
        assertTrue(AppUpdater.compareVersions("1.0.1", "1.0") > 0)
        assertTrue(AppUpdater.compareVersions("0.9", "1.0") < 0)
        assertTrue(AppUpdater.compareVersions("2.0-beta", "1.9") > 0)
    }

    private val release = """{"tag_name":"v1.1","name":"Oceanscape 1.1","body":"Fixes","published_at":"2026-10-19T00:27:22Z",
        "html_url":"https://github.com/moistpope/oceanfront-view/releases/tag/v1.1","assets":[
        {"name":"notes.txt","size":10,"browser_download_url":"https://example.com/notes.txt"},
        {"name":"oceanscape-v1.1.apk","size":28352714,"browser_download_url":"https://github.com/moistpope/oceanfront-view/releases/download/v1.1/oceanfront-view-v1.1.apk",
         "digest":"sha256:4CC896B52E044321F2D3E4FAA96EC529A7C30A230A0B1C5D8E74B0D34722C42E"}]}"""

    @Test
    fun theReleaseAndItsApk() {
        val r = AppUpdater.parseRelease(JSONObject(release))
        assertEquals("v1.1", r.tag)
        assertEquals("1.1", r.version)
        assertEquals("oceanscape-v1.1.apk", r.apkName)
        assertEquals(28352714L, r.apkSize)
        assertEquals("4cc896b52e044321f2d3e4faa96ec529a7c30a230a0b1c5d8e74b0d34722c42e", r.sha256)
    }

    @Test
    fun noDigestMeansNoHashCheck() {
        val j = JSONObject(release)
        j.getJSONArray("assets").getJSONObject(1).remove("digest")
        assertNull(AppUpdater.parseRelease(j).sha256)
    }

    @Test(expected = java.io.IOException::class)
    fun aReleaseWithoutAnApkIsNoUpdate() {
        AppUpdater.parseRelease(JSONObject("""{"tag_name":"v1.1","assets":[]}"""))
    }

    @Test
    fun sha256OfBytes() {
        assertEquals("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad", AppUpdater.sha256("abc".toByteArray()))
    }
}
