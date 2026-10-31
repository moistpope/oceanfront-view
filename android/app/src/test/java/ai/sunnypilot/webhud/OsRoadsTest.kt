package ai.sunnypilot.webhud

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class OsRoadsTest {
    private fun feature(desc: String, width: Double?, dir: String = "Both Directions") = JSONObject()
        .put("type", "Feature")
        .put("geometry", JSONObject().put("type", "LineString").put("coordinates", JSONArray()
            .put(JSONArray().put(-0.1234567).put(51.5123456).put(12.3))
            .put(JSONArray().put(-0.1230000).put(51.5130000).put(12.9))))
        .put("properties", JSONObject().put("description", desc).put("directionality", dir)
            .put("roadwidth_average", width ?: JSONObject.NULL).put("roadwidth_minimum", width?.minus(0.4) ?: JSONObject.NULL))

    @Test
    fun compactKeepsRoadsWithAWidth() {
        val out = JSONArray()
        OsRoads.compact(JSONArray()
            .put(feature("Single Carriageway", 6.04))
            .put(feature("Dual Carriageway", 7.3, "In Opposite Direction"))
            .put(feature("Path", 2.0))
            .put(feature("Single Carriageway", null)), out)
        assertEquals(2, out.length())
        val a = out.getJSONArray(0)
        assertEquals(6.0, a.getDouble(0), 1e-9)
        assertEquals(5.6, a.getDouble(1), 1e-9)
        assertEquals(0, a.getInt(2))
        assertEquals("SINGLE", a.getString(3))
        assertEquals(-0.123457, a.getDouble(4), 1e-9)   // lon, lat, the height dropped
        assertEquals(51.512346, a.getDouble(5), 1e-9)
        assertEquals(8, a.length())
        val b = out.getJSONArray(1)
        assertEquals(-1, b.getInt(2))
        assertEquals("DUAL", b.getString(3))
    }

    @Test
    fun pathsAndBounds() {
        assertEquals(Pair(1030, -3), OsRoads.parsePath("/map/os/1030/-3"))
        assertNull(OsRoads.parsePath("/map/os/status"))
        assertNull(OsRoads.parsePath("/map/features/1030/-3"))
        assertTrue(OsRoads.inGb(1030, -3))      // London
        assertFalse(OsRoads.inGb(642, -1667))   // Georgia
    }
}
