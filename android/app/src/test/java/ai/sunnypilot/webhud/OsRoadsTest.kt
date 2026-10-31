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

    private fun ring(vararg xy: Double) = JSONArray().also { r ->
        for (i in xy.indices step 2) r.put(JSONArray().put(xy[i]).put(xy[i + 1]))
        r.put(JSONArray().put(xy[0]).put(xy[1]))   // closed, as GeoJSON has it
    }

    private fun surface(desc: String, geometry: JSONObject, obscured: Boolean = false) = JSONObject()
        .put("geometry", geometry)
        .put("properties", JSONObject().put("description", desc).put("isobscured", obscured).put("physicallevel", "Surface Level"))

    @Test
    fun compactSurfaceKeepsGroundLevelRoadsAndPavements() {
        val square = JSONObject().put("type", "Polygon").put("coordinates", JSONArray()
            .put(ring(0.0, 51.0, 0.001, 51.0, 0.001, 51.001, 0.0, 51.001))
            .put(ring(0.0002, 51.0002, 0.0004, 51.0002, 0.0004, 51.0004)))
        val multi = JSONObject().put("type", "MultiPolygon").put("coordinates", JSONArray()
            .put(JSONArray().put(ring(0.0, 51.0, 0.001, 51.0, 0.001, 51.001)))
            .put(JSONArray().put(ring(0.002, 51.0, 0.003, 51.0, 0.003, 51.001))))
        val out = JSONArray()
        OsRoads.compactSurface(JSONArray()
            .put(surface("Road", square))
            .put(surface("Pavement", multi))
            .put(surface("Path", square))
            .put(surface("Road", square, obscured = true)), out)
        assertEquals(3, out.length())
        val road = out.getJSONArray(0)
        assertEquals("R", road.getString(0))
        assertEquals(3, road.length())                  // the outline and its hole
        assertEquals(8, road.getJSONArray(1).length())  // four points, not closed
        assertEquals(6, road.getJSONArray(2).length())
        assertEquals("P", out.getJSONArray(1).getString(0))
        assertEquals("P", out.getJSONArray(2).getString(0))
    }

    @Test
    fun pathsAndBounds() {
        assertEquals(Pair(1030, -3), OsRoads.parsePath("/map/os/1030/-3"))
        assertNull(OsRoads.parsePath("/map/os/status"))
        assertNull(OsRoads.parsePath("/map/features/1030/-3"))
        assertEquals(Pair(1030, -3), OsRoads.parsePath("/map/ossurf/1030/-3", "ossurf"))
        assertTrue(OsRoads.inGb(1030, -3))      // London
        assertFalse(OsRoads.inGb(642, -1667))   // Georgia
    }
}
