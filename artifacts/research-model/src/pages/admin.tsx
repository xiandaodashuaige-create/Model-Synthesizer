import { useApproveUser, useListAdminUsers } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useT } from "@/lib/i18n";
import { Link } from "wouter";
import { ArrowLeft, CheckCircle, XCircle, Shield, Clock, Loader2 } from "lucide-react";

export default function AdminPage() {
  const { t } = useT();
  const queryClient = useQueryClient();
  const { data, isLoading, error } = useListAdminUsers();
  const approveMutation = useApproveUser();

  const handleApprove = (userId: string, approved: boolean) => {
    approveMutation.mutate(
      { userId, data: { approved } },
      {
        onSuccess: () => {
          queryClient.invalidateQueries({ queryKey: ["listAdminUsers"] });
        },
      },
    );
  };

  return (
    <div className="min-h-screen bg-background px-4 py-8">
      <div className="max-w-3xl mx-auto">
        {/* Header */}
        <div className="flex items-center gap-3 mb-6">
          <Link href="/">
            <button className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors">
              <ArrowLeft className="w-4 h-4" />
              {t("admin.back" as any)}
            </button>
          </Link>
        </div>

        <div className="flex items-center gap-3 mb-2">
          <Shield className="w-6 h-6 text-primary" />
          <h1 className="text-xl font-semibold text-foreground">{t("admin.title" as any)}</h1>
        </div>
        <p className="text-sm text-muted-foreground mb-8">{t("admin.subtitle" as any)}</p>

        {/* Table */}
        <div className="bg-card border border-border rounded-xl overflow-hidden">
          {isLoading ? (
            <div className="flex items-center justify-center py-16 gap-2 text-muted-foreground">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-sm">加载中…</span>
            </div>
          ) : error ? (
            <div className="py-12 text-center text-sm text-destructive">加载失败，请刷新重试</div>
          ) : !data?.users?.length ? (
            <div className="py-12 text-center text-sm text-muted-foreground">{t("admin.empty" as any)}</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="border-b border-border bg-muted/30">
                <tr>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("admin.col.user" as any)}</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden sm:table-cell">{t("admin.col.email" as any)}</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider hidden md:table-cell">{t("admin.col.joined" as any)}</th>
                  <th className="text-left px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("admin.col.status" as any)}</th>
                  <th className="text-right px-5 py-3 text-xs font-medium text-muted-foreground uppercase tracking-wider">{t("admin.col.action" as any)}</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border">
                {data.users.map((user) => {
                  const name = [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || user.id;
                  const isSaving = approveMutation.isPending && (approveMutation.variables as any)?.userId === user.id;
                  return (
                    <tr key={user.id} className="hover:bg-muted/20 transition-colors">
                      <td className="px-5 py-3.5">
                        <div className="flex items-center gap-2.5">
                          {user.profileImageUrl ? (
                            <img src={user.profileImageUrl} alt="" className="w-7 h-7 rounded-full shrink-0 object-cover" />
                          ) : (
                            <div className="w-7 h-7 rounded-full bg-muted flex items-center justify-center shrink-0 text-xs font-medium text-muted-foreground">
                              {(name[0] ?? "?").toUpperCase()}
                            </div>
                          )}
                          <span className="font-medium text-foreground truncate max-w-[120px]">{name}</span>
                        </div>
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground hidden sm:table-cell truncate max-w-[180px]">
                        {user.email ?? "—"}
                      </td>
                      <td className="px-5 py-3.5 text-muted-foreground hidden md:table-cell">
                        {new Date(user.createdAt).toLocaleDateString("zh-CN")}
                      </td>
                      <td className="px-5 py-3.5">
                        {user.isAdmin ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300 font-medium">
                            <Shield className="w-3 h-3" />
                            {t("admin.status.admin" as any)}
                          </span>
                        ) : user.approved ? (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300 font-medium">
                            <CheckCircle className="w-3 h-3" />
                            {t("admin.status.approved" as any)}
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-amber-100 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 font-medium">
                            <Clock className="w-3 h-3" />
                            {t("admin.status.pending" as any)}
                          </span>
                        )}
                      </td>
                      <td className="px-5 py-3.5 text-right">
                        {user.isAdmin ? (
                          <span className="text-xs text-muted-foreground">—</span>
                        ) : user.approved ? (
                          <button
                            onClick={() => handleApprove(user.id, false)}
                            disabled={isSaving}
                            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-destructive/40 text-destructive hover:bg-destructive/10 transition-colors disabled:opacity-50"
                          >
                            {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <XCircle className="w-3 h-3" />}
                            {isSaving ? t("admin.btn.saving" as any) : t("admin.btn.revoke" as any)}
                          </button>
                        ) : (
                          <button
                            onClick={() => handleApprove(user.id, true)}
                            disabled={isSaving}
                            className="inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-md border border-primary/40 text-primary hover:bg-primary/10 transition-colors disabled:opacity-50"
                          >
                            {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />}
                            {isSaving ? t("admin.btn.saving" as any) : t("admin.btn.approve" as any)}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
