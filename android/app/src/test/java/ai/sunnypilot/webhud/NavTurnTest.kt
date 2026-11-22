package ai.sunnypilot.webhud

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import kotlin.math.PI
import kotlin.math.cos
import kotlin.math.hypot
import kotlin.math.roundToInt
import kotlin.math.sin

class NavTurnTest {
    private val s = 64

    // a white picture on a clear ground, drawn with thick strokes and arrow heads (as navicon.test.js)
    private fun dot(img: IntArray, x: Double, y: Double) {
        val xi = x.roundToInt(); val yi = y.roundToInt()
        if (xi in 0 until s && yi in 0 until s) img[yi * s + xi] = -1
    }

    private fun stroke(img: IntArray, a: DoubleArray, b: DoubleArray, r: Int = 3) {
        val l = hypot(b[0] - a[0], b[1] - a[1])
        if (l == 0.0) { dot(img, a[0], a[1]); return }
        var t = 0.0
        while (t <= l) {
            for (dx in -r..r) for (dy in -r..r) if (dx * dx + dy * dy <= r * r)
                dot(img, a[0] + (b[0] - a[0]) * t / l + dx, a[1] + (b[1] - a[1]) * t / l + dy)
            t += 0.5
        }
    }

    private fun head(img: IntArray, from: DoubleArray, to: DoubleArray, size: Double = 9.0) {
        val l = hypot(to[0] - from[0], to[1] - from[1]); val ux = (to[0] - from[0]) / l; val uy = (to[1] - from[1]) / l
        var a = 0.0
        while (a <= size) {
            val w = size - a
            stroke(img, doubleArrayOf(to[0] - ux * (size - a) + uy * w, to[1] - uy * (size - a) - ux * w),
                doubleArrayOf(to[0] - ux * (size - a) - uy * w, to[1] - uy * (size - a) + ux * w), 1)
            a += 0.5
        }
    }

    private fun arrow(vararg pts: DoubleArray): IntArray {
        val img = IntArray(s * s)
        for (i in 1 until pts.size) stroke(img, pts[i - 1], pts[i])
        head(img, pts[pts.size - 2], pts.last())
        return img
    }

    private fun p(x: Int, y: Int) = doubleArrayOf(x.toDouble(), y.toDouble())

    private fun roundabout(deg: Double): IntArray {
        val img = IntArray(s * s); val c = p(32, 30); val r = 12.0
        var a = 0
        while (a < 360) {
            val a0 = a * PI / 180; val a1 = (a + 2) * PI / 180
            stroke(img, doubleArrayOf(c[0] + r * sin(a0), c[1] - r * cos(a0)), doubleArrayOf(c[0] + r * sin(a1), c[1] - r * cos(a1)), 2)
            a += 2
        }
        stroke(img, p(32, 62), doubleArrayOf(32.0, 30 + r))
        val rr = deg * PI / 180
        val from = doubleArrayOf(c[0] + r * sin(rr), c[1] - r * cos(rr)); val to = doubleArrayOf(c[0] + 28 * sin(rr), c[1] - 28 * cos(rr))
        stroke(img, from, to)
        head(img, from, to, 6.0)
        return img
    }

    @Test
    fun turnsInThePicture() {
        assertEquals("right", NavTurn.iconTurn(arrow(p(30, 62), p(30, 30), p(58, 30)), s, s))
        assertEquals("left", NavTurn.iconTurn(arrow(p(34, 62), p(34, 30), p(6, 30)), s, s))
        assertEquals("right", NavTurn.iconTurn(arrow(p(20, 62), p(20, 14), p(54, 46)), s, s))   // sharp
        assertEquals("", NavTurn.iconTurn(arrow(p(32, 62), p(32, 6)), s, s))                    // straight on
        assertEquals("", NavTurn.iconTurn(arrow(p(28, 62), p(28, 36), p(50, 8)), s, s))         // slight
        assertEquals("", NavTurn.iconTurn(arrow(p(48, 62), p(48, 16), p(16, 16), p(16, 50)), s, s))   // U-turn
        assertEquals("", NavTurn.iconTurn(roundabout(90.0), s, s))
        assertNull(NavTurn.iconTurn(IntArray(s * s), s, s))
    }

    @Test
    fun distances() {
        assertEquals(300.0, NavTurn.distanceOf("300 m")!!.first, 1e-9)
        assertEquals(50.0, NavTurn.distanceOf("300 m")!!.second, 1e-9)
        assertEquals(0.3 * 1609.344, NavTurn.distanceOf("0.3 mi")!!.first, 1e-6)
        assertEquals(5 * 0.9144, NavTurn.distanceOf("Turn left in 80 yd")!!.second, 1e-9)
        assertEquals(1200.0, NavTurn.distanceOf("1,2 km")!!.first, 1e-9)
        assertNull(NavTurn.distanceOf("Hartwith Lane"))
    }

    @Test
    fun turnsInTheWords() {
        val t = NavTurn.of("200 m", "Turn right onto Hartwith Lane", "", "", "Maps", null, 0, 0)!!
        assertEquals("right", t.direction)
        assertEquals(200.0, t.distance, 1e-9)
        assertEquals(50.0, t.tolerance, 1e-9)   // "200 m": rounded to the hundred
        assertEquals("Turn right onto Hartwith Lane", t.step)
        assertEquals("left", NavTurn.of("In 300 m, turn left", "", "", "", "Maps", null, 0, 0)!!.direction)
        assertEquals("left", NavTurn.of("Sharp left in 80 yd", "", "", "", "Maps", null, 0, 0)!!.direction)
        assertNull(NavTurn.of("300 m", "Slight right onto A61", "", "", "Maps", null, 0, 0))
        assertNull(NavTurn.of("300 m", "At the roundabout, take the 2nd exit", "", "", "Maps", null, 0, 0))
        assertNull(NavTurn.of("300 m", "Keep left at the fork", "", "", "Maps", null, 0, 0))
        assertNull(NavTurn.of("Turn right onto Hartwith Lane", "12 min · 8 km", "", "", "Maps", null, 0, 0))   // no distance to it
    }

    @Test
    fun theRoadOnlyAndThePicture() {
        // Google Maps: "200 m" and the road, the turn drawn as its icon
        val right = arrow(p(30, 62), p(30, 30), p(58, 30))
        val t = NavTurn.of("200 m", "Hartwith Lane", "", "", "Maps", right, s, s)!!
        assertEquals("right", t.direction)
        assertEquals("Hartwith Lane", t.step)
        assertNull(NavTurn.of("200 m", "Hartwith Lane", "", "", "Maps", null, 0, 0))
        assertNull(NavTurn.of("200 m", "Hartwith Lane", "", "", "Maps", arrow(p(32, 62), p(32, 6)), s, s))
    }
}
