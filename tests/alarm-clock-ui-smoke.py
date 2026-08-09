"""Alarm clock interaction smoke test. Requires Python Playwright and Chromium."""

import os

from playwright.sync_api import expect, sync_playwright


BASE_URL = os.environ.get("DTKIT_TEST_BASE_URL", "http://127.0.0.1:4173")


with sync_playwright() as playwright:
    browser = playwright.chromium.launch(headless=True)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    errors = []
    page.on("pageerror", lambda error: errors.append(f"pageerror: {error}"))
    page.on(
        "console",
        lambda message: errors.append(f"console.error: {message.text}")
        if message.type == "error"
        else None,
    )
    page.add_init_script("localStorage.removeItem('alarm_clock_data')")
    page.goto(BASE_URL, wait_until="networkidle")
    page.locator('#toolLibraryView [data-tool-id="alarm-clock"]').click()
    page.locator(".alarm-clock-view").wait_for(state="visible")
    expect(page.locator("#alarmSyncStatus")).to_contain_text("调度就绪")
    page.evaluate(
        "window.dispatchEvent(new CustomEvent('dtkit:alarm-sync-status', "
        "{ detail: { state: 'failed', attempt: 4, maxAttempts: 4, error: 'test' } }))"
    )
    expect(page.locator("#alarmSyncStatus")).to_have_attribute("data-state", "failed")
    expect(page.locator("#alarmSyncStatus")).to_contain_text("调度未同步")
    page.evaluate(
        "window.dispatchEvent(new CustomEvent('dtkit:alarm-sync-status', "
        "{ detail: { state: 'synced', attempt: 2, maxAttempts: 4 } }))"
    )
    expect(page.locator("#alarmSyncStatus")).to_contain_text("调度已恢复")

    page.locator("#alarmActionType").select_option("sound")
    expect(page.locator("#addTaskBtn")).to_be_disabled()
    expect(page.locator(".alarm-no-audio")).to_contain_text("未找到音频文件")
    page.locator("#alarmActionType").select_option("notify")
    expect(page.locator("#addTaskBtn")).to_be_enabled()

    page.locator("#alarmTaskType").select_option("fixed")
    page.locator("#alarmTaskName").fill("一次提醒")
    page.locator("#alarmTimeInput").fill("23:59")
    page.locator("#repeatEnabled").uncheck()
    expect(page.locator("#repeatDaysGroup")).to_be_hidden()
    page.locator("#addTaskBtn").click()
    expect(page.locator(".alarm-task-card")).to_have_count(1)

    stored = page.evaluate("JSON.parse(localStorage.getItem('alarm_clock_data'))")
    if stored["tasks"][0]["config"]["repeatEnabled"] is not False:
        raise AssertionError(f"One-time repeat state was not persisted: {stored!r}")
    expect(page.locator("#nextAlarmCountdown")).not_to_have_text("--:--:--")

    first_task = stored["tasks"][0]
    page.evaluate(
        "task => window.dispatchEvent(new CustomEvent('dtkit:alarm-triggered', { detail: task }))",
        first_task,
    )
    expect(page.locator(".alarm-task-card")).to_have_class("alarm-task-card disabled")

    for name, minutes in (("短倒计时", "1"), ("长倒计时", "2")):
        page.locator("#alarmTaskType").select_option("countdown")
        page.locator("#alarmTaskName").fill(name)
        page.locator("#countdownHours").fill("0")
        page.locator("#countdownMinutes").fill(minutes)
        page.locator("#countdownSeconds").fill("0")
        page.locator("#addTaskBtn").click()

    expect(page.locator(".alarm-task-card")).to_have_count(3)
    page.locator(".alarm-task-card").first.locator(".alarm-task-btn--pause").click()
    expect(page.locator(".alarm-task-card.paused")).to_have_count(1)
    paused_tasks = page.evaluate(
        "JSON.parse(localStorage.getItem('alarm_clock_data')).tasks.filter(task => task.paused)"
    )
    if len(paused_tasks) != 1:
        raise AssertionError(f"Paused task state was not persisted: {paused_tasks!r}")
    page.locator(".alarm-task-card.paused .alarm-task-btn--resume").click()
    expect(page.locator(".alarm-task-card.paused")).to_have_count(0)

    order_before = page.evaluate(
        "JSON.parse(localStorage.getItem('alarm_clock_data')).tasks.map(task => task.id)"
    )
    page.evaluate(
        """
        () => {
            const panel = document.getElementById('taskListPanel');
            const cards = panel.querySelectorAll('.alarm-task-card');
            cards[0].querySelector('.alarm-task-drag-handle')
                .dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
            const transfer = new DataTransfer();
            cards[0].dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
            const rect = cards[2].getBoundingClientRect();
            cards[2].dispatchEvent(new DragEvent('dragover', {
                bubbles: true,
                cancelable: true,
                clientY: rect.bottom,
                dataTransfer: transfer
            }));
            panel.dispatchEvent(new DragEvent('drop', {
                bubbles: true,
                cancelable: true,
                dataTransfer: transfer
            }));
            cards[0].dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
        }
        """
    )
    order_after = page.evaluate(
        "JSON.parse(localStorage.getItem('alarm_clock_data')).tasks.map(task => task.id)"
    )
    if order_after == order_before:
        raise AssertionError("Native task reordering did not persist a changed order")

    if errors:
        raise AssertionError("Browser runtime errors:\n" + "\n".join(errors))
    browser.close()
