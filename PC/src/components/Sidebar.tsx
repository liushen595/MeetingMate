const navItems = ["文档库", "手稿", "AI 工作台", "导出", "设置"];

export function Sidebar(): React.JSX.Element {
  return (
    <aside className="flex w-20 flex-col items-center border-r border-slate-200 bg-slate-950 py-5 text-slate-300">
      <div className="mb-8 flex h-11 w-11 items-center justify-center rounded-2xl bg-blue-500 text-lg font-bold text-white">
        M
      </div>
      <nav className="flex w-full flex-col gap-2 px-2">
        {navItems.map((item, index) => (
          <button
            className={`rounded-xl px-2 py-3 text-xs transition ${
              index === 0 ? "bg-white text-slate-950" : "hover:bg-slate-800 hover:text-white"
            }`}
            key={item}
            type="button"
          >
            {item}
          </button>
        ))}
      </nav>
      <div className="mt-auto text-[10px] text-slate-500">MVP</div>
    </aside>
  );
}
