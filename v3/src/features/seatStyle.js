/* Table style (the "seatStyle" switch, named for where it started): folded
 * players darkened rather than faded, 4px corners and even spacing on the
 * seats, and the classic add-on's bevels on the frame and buttons. CSS only
 * (style.css, under html.gpt-seats); this switches the class.
 *
 * ui2 fades a folded seat piece by piece: the avatar goes to 70% opacity over
 * a box it paints solid white only while folded. The white then shows through
 * the whole picture, and wholly through a transparent avatar, and that box has
 * square corners where the picture's are cut round. A filter that darkens,
 * with no opacity, leaves nothing to show through. */

export function startSeatStyle() {
    const root = document.documentElement;
    root.classList.add("gpt-seats");
    return () => root.classList.remove("gpt-seats");
}
